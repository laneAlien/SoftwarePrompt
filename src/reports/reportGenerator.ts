import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { SimulationReport } from '../simulation/reporter';

export interface ExportOptions {
  format: 'pdf' | 'json' | 'csv';
  filePath?: string;
}

export function exportReport(report: SimulationReport, options: ExportOptions): string {
  const target = path.resolve(options.filePath || `report.${options.format}`);

  if (options.format === 'json') {
    fs.writeFileSync(target, JSON.stringify(report, null, 2));
    return target;
  }

  if (options.format === 'csv') {
    const rows = report.orders
      .map((o) => `${o.timestamp},${o.side},${o.price},${o.size},${o.pnl}`)
      .join('\n');
    fs.writeFileSync(target, `timestamp,side,price,size,pnl\n${rows}`);
    return target;
  }

  const doc = new PDFDocument();
  doc.pipe(fs.createWriteStream(target));
  doc.fontSize(16).text('Simulation Report', { underline: true });
  doc.moveDown();
  doc.fontSize(12).text(`Symbol: ${report.symbol}`);
  doc.text(`Timeframe: ${report.timeframe}`);
  doc.text(`Final Balance: ${report.finalBalanceUsd.toFixed(2)} USD`);
  doc.text(`PnL: ${report.pnlUsd.toFixed(2)} USD`);
  doc.moveDown();
  doc.text('Orders:');
  report.orders.slice(-20).forEach((o) => {
    doc.text(`${new Date(o.timestamp).toISOString()} | ${o.side} | ${o.price} | size ${o.size} | pnl ${o.pnl}`);
  });
  doc.end();
  return target;
}

