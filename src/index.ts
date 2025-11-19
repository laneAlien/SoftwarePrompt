import 'dotenv/config';
import { runCLI } from './ui/cli';
import { startTelegramBot } from './ui/telegramBot';

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║   Crypto Trading AI Assistant v1.0.0                     ║');
console.log('║   Educational & Analytical Tool - Not Financial Advice    ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log('');

if (process.argv.length === 2) {
  console.log('Usage: npm start <command> [options]');
  console.log('');
  console.log('Available commands:');
  console.log('  simulate         - Generate and analyze artificial market data');
  console.log('  trade-sim        - Run AI trading bot simulation');
  console.log('  analyze-pair     - Analyze real trading pair from exchange');
  console.log('  analyze-portfolio - Analyze portfolio across exchanges');
  console.log('  analyze-news     - Analyze crypto news and signals');
  console.log('');
  console.log('Examples:');
  console.log('  npm start simulate -- --symbol TONUSDT --timeframe 15m --candles 500 --initial-price 2.5');
  console.log('  npm start trade-sim -- --symbol TONUSDT --timeframe 15m --candles 1000 --initial-price 2.5');
  console.log('  npm start analyze-news -- --symbol TON');
  console.log('');
  console.log('For detailed help: npm start <command> -- --help');
  console.log('');
  
  if (process.env.TELEGRAM_BOT_TOKEN) {
    startTelegramBot();
  }
} else {
  runCLI();
}
