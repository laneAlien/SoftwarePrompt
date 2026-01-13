import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import asciichart from 'asciichart';
import fs from 'fs';
import path from 'path';
import { Candle } from '../core/types';

export interface ChartDataset {
  label: string;
  data: Array<number | null>;
  borderColor?: string;
  backgroundColor?: string;
  fill?: boolean;
}

export async function renderChartPNG(candles: Candle[], filePath = 'chart.png'): Promise<string> {
  const width = 800;
  const height = 400;
  const chart = new ChartJSNodeCanvas({ width, height });
  const configuration = {
    type: 'line',
    data: {
      labels: candles.map((c) => new Date(c.timestamp).toLocaleString()),
      datasets: [
        {
          label: 'Close',
          data: candles.map((c) => c.close),
          borderColor: 'rgba(75,192,192,1)',
          fill: false,
        },
      ],
    },
  } as any;

  const buffer = await chart.renderToBuffer(configuration);
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, buffer);
  return resolved;
}

export async function renderLineChartPNG(
  labels: string[],
  datasets: ChartDataset[],
  filePath: string,
  options: { width?: number; height?: number; title?: string } = {}
): Promise<string> {
  const width = options.width ?? 900;
  const height = options.height ?? 450;
  const chart = new ChartJSNodeCanvas({ width, height });
  const configuration = {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((dataset) => ({
        ...dataset,
        data: dataset.data,
        borderColor: dataset.borderColor ?? 'rgba(75,192,192,1)',
        backgroundColor: dataset.backgroundColor ?? 'rgba(75,192,192,0.2)',
        fill: dataset.fill ?? false,
        pointRadius: 0,
        borderWidth: 2,
      })),
    },
    options: {
      plugins: {
        title: options.title
          ? {
              display: true,
              text: options.title,
            }
          : undefined,
        legend: {
          display: true,
          position: 'top',
        },
      },
      responsive: false,
    },
  } as any;

  const buffer = await chart.renderToBuffer(configuration);
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, buffer);
  return resolved;
}

export async function renderBarChartPNG(
  labels: string[],
  datasets: ChartDataset[],
  filePath: string,
  options: { width?: number; height?: number; title?: string } = {}
): Promise<string> {
  const width = options.width ?? 900;
  const height = options.height ?? 450;
  const chart = new ChartJSNodeCanvas({ width, height });
  const configuration = {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map((dataset) => ({
        ...dataset,
        data: dataset.data,
        backgroundColor: dataset.backgroundColor ?? 'rgba(54,162,235,0.6)',
        borderColor: dataset.borderColor ?? 'rgba(54,162,235,1)',
        borderWidth: 1,
      })),
    },
    options: {
      plugins: {
        title: options.title
          ? {
              display: true,
              text: options.title,
            }
          : undefined,
        legend: {
          display: true,
          position: 'top',
        },
      },
      responsive: false,
      scales: {
        x: {
          ticks: {
            autoSkip: true,
            maxRotation: 45,
            minRotation: 0,
          },
        },
      },
    },
  } as any;

  const buffer = await chart.renderToBuffer(configuration);
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, buffer);
  return resolved;
}

export function renderAsciiChart(candles: Candle[]): string {
  const series = candles.map((c) => c.close);
  return asciichart.plot(series, { height: 15 });
}

export function renderAsciiChartSeries(series: number[][], height = 15): string {
  return asciichart.plot(series, { height });
}
