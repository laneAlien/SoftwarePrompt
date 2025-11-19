export interface SimulationReport {
  finalBalance: number;
  initialBalance: number;
  tradesCount: number;
  liquidationsCount: number;
  maxDrawdownPercent: number;
  log: string[];
}

export function buildSimulationReport(
  initialBalance: number,
  finalBalance: number,
  tradesCount: number,
  liquidationsCount: number,
  maxDrawdownPercent: number,
  log: string[]
): SimulationReport {
  return {
    finalBalance,
    initialBalance,
    tradesCount,
    liquidationsCount,
    maxDrawdownPercent,
    log,
  };
}

export function formatSimulationReport(report: SimulationReport): string {
  const pnl = report.finalBalance - report.initialBalance;
  const pnlPercent = ((pnl / report.initialBalance) * 100).toFixed(2);
  
  const lines = [
    '═'.repeat(60),
    'SIMULATION REPORT',
    '═'.repeat(60),
    '',
    `Initial Balance:     $${report.initialBalance.toFixed(2)}`,
    `Final Balance:       $${report.finalBalance.toFixed(2)}`,
    `PnL:                 $${pnl.toFixed(2)} (${pnlPercent}%)`,
    `Total Trades:        ${report.tradesCount}`,
    `Liquidations:        ${report.liquidationsCount}`,
    `Max Drawdown:        ${report.maxDrawdownPercent.toFixed(2)}%`,
    '',
    '─'.repeat(60),
    'Trade Log:',
    '─'.repeat(60),
  ];

  for (const entry of report.log) {
    lines.push(entry);
  }

  lines.push('═'.repeat(60));

  return lines.join('\n');
}
