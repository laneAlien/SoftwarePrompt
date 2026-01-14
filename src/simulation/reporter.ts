export interface SimulationReport {
  initialBalance: number;
  finalBalance: number;
  pnl: number;
  pnlPercent: number;
  trades: number;
  winRatePercent: number;
  liquidations: number;
  maxDrawdownPercent: number;
  feesPaid: number;
  noTradeReasons: Array<{ reason: string; count: number }>;
  log: string[];
}

export function buildSimulationReport(
  initialBalance: number,
  finalBalance: number,
  tradesCount: number,
  winRatePercent: number,
  liquidationsCount: number,
  maxDrawdownPercent: number,
  feesPaid: number,
  noTradeReasons: Array<{ reason: string; count: number }>,
  log: string[]
): SimulationReport {
  const pnl = finalBalance - initialBalance;
  const pnlPercent = initialBalance > 0 ? (pnl / initialBalance) * 100 : 0;
  return {
    initialBalance,
    finalBalance,
    pnl,
    pnlPercent,
    trades: tradesCount,
    winRatePercent,
    liquidations: liquidationsCount,
    maxDrawdownPercent,
    feesPaid,
    noTradeReasons,
    log,
  };
}

export function formatSimulationReport(report: SimulationReport): string {
  const lines = [
    '═'.repeat(60),
    'SIMULATION REPORT',
    '═'.repeat(60),
    '',
    `Initial Balance:     $${report.initialBalance.toFixed(2)}`,
    `Final Balance:       $${report.finalBalance.toFixed(2)}`,
    `PnL:                 $${report.pnl.toFixed(2)} (${report.pnlPercent.toFixed(2)}%)`,
    `Total Trades:        ${report.trades}`,
    `Win Rate:            ${report.winRatePercent.toFixed(2)}%`,
    `Liquidations:        ${report.liquidations}`,
    `Max Drawdown:        ${report.maxDrawdownPercent.toFixed(2)}%`,
    `Fees Paid:           $${report.feesPaid.toFixed(2)}`,
    `Top No-Trade Reasons:`,
    ...report.noTradeReasons.map((entry) => `  - ${entry.reason} (${entry.count})`),
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
