import { LineChartIcon, Loader2Icon } from 'lucide-react';
import React, { ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react';
import DebouncedResizeContainer from '@/components/DebouncedResizeContainer';
import drawFullPerfChart from './drawFullPerfChart';
import { BackendApiError, useBackendApi } from '@/hooks/fetch';
import type { SvRtPerfCountsThreadType, PerfChartApiSuccessResp } from "@shared/otherTypes";
import useSWR from 'swr';
import { PerfSnapType, formatTickBoundary, getBucketTicketsEstimatedTime, getTimeWeightedHistogram, processPerfLog } from './chartingUtils';
import { useThrottledSetCursor } from './dashboardHooks';
import { useIsDarkMode } from '@/hooks/theme';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type FullPerfChartProps = {
    threadName: string;
    apiData: PerfChartApiSuccessResp;
    width: number;
    height: number;
    isDarkMode: boolean;
};

const FullPerfChart = memo(({ threadName, apiData, width, height, isDarkMode }: FullPerfChartProps) => {
    const setCursor = useThrottledSetCursor();
    const svgRef = useRef<SVGSVGElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const margins = {
        top: 0,
        right: 50,
        bottom: 30,
        left: 40,
        axis: 1
    };

    //Process data only once
    const processedData = useMemo(() => {
        if (!apiData) return null;
        const bucketTicketsEstimatedTime = getBucketTicketsEstimatedTime(apiData.boundaries);
        const perfProcessor = (perfLog: SvRtPerfCountsThreadType) => {
            return getTimeWeightedHistogram(perfLog.buckets, bucketTicketsEstimatedTime);
        }
        // apiData.threadPerfLog = apiData.threadPerfLog.slice(-50)
        const parsed = processPerfLog(apiData.threadPerfLog, perfProcessor);
        if (!parsed) return null;

        return {
            ...parsed,
            bucketLabels: apiData.boundaries.map(formatTickBoundary),
            cursorSetter: (snap: PerfSnapType | undefined) => {
                if (!snap) return setCursor(undefined);
                setCursor({
                    threadName,
                    snap,
                });
            },
        }
    }, [apiData, threadName, isDarkMode]);


    //Redraw chart when data or size changes
    useEffect(() => {
        if (!processedData || !svgRef.current || !canvasRef.current || !width || !height) return;
        if (!processedData.lifespans.length) return; //only in case somehow the api returned, but no data found
        console.groupCollapsed('Drawing full performance chart:');
        console.log('useEffect:', processedData, svgRef.current, canvasRef.current, width, height);
        console.time('drawFullPerfChart');
        drawFullPerfChart({
            svgRef: svgRef.current,
            canvasRef: canvasRef.current,
            size: { width, height },
            margins,
            isDarkMode,
            ...processedData,
        });
        console.timeEnd('drawFullPerfChart');
        console.groupEnd();
    }, [processedData, width, height, svgRef, canvasRef]);


    if (!width || !height) return null;
    return (<>
        <svg
            ref={svgRef}
            width={width}
            height={height}
            style={{
                zIndex: 1,
                position: 'absolute',
                top: '0px',
                left: '0px'
            }}
        />
        <canvas
            ref={canvasRef}
            width={width - margins.left - margins.right}
            height={height - margins.top - margins.bottom}
            style={{
                zIndex: 0,
                position: 'absolute',
                top: `${margins.top}px`,
                left: `${margins.left}px`,
            }}
        />
    </>);
});

function ChartErrorMessage({ error }: { error: Error | BackendApiError }) {
    const errorMessageMaps: Record<string, ReactNode> = {
        bad_request: 'Chart data loading failed: bad request.',
        invalid_thread_name: 'Chart data loading failed: invalid thread name.',
        data_unavailable: 'Chart data loading failed: data not yet available.',
        not_enough_data: (<p className='text-center'>
            <strong>There is not enough data to display the chart just yet.</strong><br />
            <span className='text-base italic'>
                The chart requires at least 30 minutes of server runtime data to be available.
            </span>
        </p>),
    };

    if (error instanceof BackendApiError) {
        return (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-2xl text-muted-foreground">
                {errorMessageMaps[error.message] ?? 'Unknown BackendApiError'}
            </div>
        );
    } else {
        return (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-2xl text-destructive-inline">
                Error: {error.message ?? 'Unknown Error'}
            </div>
        );
    }
}


export default function FullPerfCard() {
    const [chartSize, setChartSize] = useState({ width: 0, height: 0 });
    const [selectedThread, setSelectedThread] = useState('svMain');
    const isDarkMode = useIsDarkMode();

    const chartApi = useBackendApi<PerfChartApiSuccessResp>({
        method: 'GET',
        path: `/perfChartData/:thread/`,
        throwGenericErrors: true,
    });

    const swrChartApiResp = useSWR('/perfChartData/:thread', async () => {
        const data = await chartApi({
            pathParams: { thread: selectedThread },
        });
        if (!data) throw new Error('empty_response');
        return data;
    }, {});

    useEffect(() => {
        swrChartApiResp.mutate();
        //FIXME: should probably clear the data when changing the thread
    }, [selectedThread]);

    //Rendering
    let contentNode: React.ReactNode = null;
    if (swrChartApiResp.data) {
        contentNode = <FullPerfChart
            threadName={selectedThread}
            apiData={swrChartApiResp.data}
            width={chartSize.width}
            height={chartSize.height}
            isDarkMode={isDarkMode}
        />;
    } else if (swrChartApiResp.isLoading) {
        contentNode = <div className="absolute inset-0 flex flex-col items-center justify-center">
            <Loader2Icon className="animate-spin size-16 text-muted-foreground" />
        </div>;
    } else if (swrChartApiResp.error) {
        contentNode = <ChartErrorMessage error={swrChartApiResp.error} />;
    }

    return (
        <div className="w-full h-[28rem] py-2 md:rounded-lg border bg-card shadow-sm flex flex-col fill-primary">
            <div className="px-4 flex flex-row items-center justify-between space-y-0 pb-2 text-muted-foreground">
                <h3 className="tracking-tight text-sm font-medium line-clamp-1">
                    Server performance
                </h3>
                <div className="flex gap-4">
                    <Select defaultValue={selectedThread} onValueChange={setSelectedThread}>
                        <SelectTrigger className="w-32 grow md:grow-0 h-6 px-3 py-1 text-sm" >
                            <SelectValue placeholder="Filter by admin" />
                        </SelectTrigger>
                        <SelectContent className="px-0">
                            <SelectItem value={'svMain'} className="cursor-pointer">
                                svMain
                            </SelectItem>
                            <SelectItem value={'svSync'} className="cursor-pointer">
                                svSync
                            </SelectItem>
                            <SelectItem value={'svNetwork'} className="cursor-pointer">
                                svNetwork
                            </SelectItem>
                        </SelectContent>
                    </Select>
                    <div className='hidden xs:block'><LineChartIcon /></div>
                </div>
            </div>
            <DebouncedResizeContainer onDebouncedResize={setChartSize}>
                {contentNode}
            </DebouncedResizeContainer>
        </div>
    );
}