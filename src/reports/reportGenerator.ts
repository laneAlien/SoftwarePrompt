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
    const rows = [
      'metric,value',
      `initial_balance,${report.initialBalance}`,
      `final_balance,${report.finalBalance}`,
      `pnl,${report.pnl}`,
      `pnl_percent,${report.pnlPercent}`,
      `trades,${report.trades}`,
      `liquidations,${report.liquidations}`,
      `max_drawdown_percent,${report.maxDrawdownPercent}`,
    ].join('\n');
    fs.writeFileSync(target, rows);
    return target;
  }

  const doc = new PDFDocument();
  doc.pipe(fs.createWriteStream(target));
  doc.fontSize(16).text('Simulation Report', { underline: true });
  doc.moveDown();
  doc.fontSize(12).text(`Initial Balance: $${report.initialBalance.toFixed(2)}`);
  doc.text(`Final Balance:   $${report.finalBalance.toFixed(2)}`);
  doc.text(`PnL:             $${report.pnl.toFixed(2)} (${report.pnlPercent.toFixed(2)}%)`);
  doc.text(`Trades:          ${report.trades}`);
  doc.text(`Liquidations:    ${report.liquidations}`);
  doc.text(`Max Drawdown:    ${report.maxDrawdownPercent.toFixed(2)}%`);
  doc.moveDown();
  doc.text('Recent Log Entries:');
  report.log.slice(-10).forEach((entry) => doc.text(entry));
  doc.end();
  return target;
}

