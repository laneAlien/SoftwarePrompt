import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import asciichart from 'asciichart';
import fs from 'fs';
import path from 'path';
import { Candle } from '../core/types';

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

export function renderAsciiChart(candles: Candle[]): string {
  const series = candles.map((c) => c.close);
  return asciichart.plot(series, { height: 15 });
}

