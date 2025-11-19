import TelegramBot from 'node-telegram-bot-api';

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.log('TELEGRAM_BOT_TOKEN not set. Telegram bot will not start.');
    console.log('To enable Telegram bot, set TELEGRAM_BOT_TOKEN in your .env file.');
    return;
  }

  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'Welcome to Crypto Trading AI Assistant!\n\n' +
      'This is an analytical and simulation tool, NOT for real automated trading.\n\n' +
      'Available commands:\n' +
      '/start - Show this message\n' +
      '/help - Get help\n\n' +
      'Note: Full functionality available via CLI. Telegram bot is a minimal stub.'
    );
  });

  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'For full functionality, use the CLI interface:\n\n' +
      'Commands:\n' +
      '- trade-sim: Run trading simulation\n' +
      '- analyze-pair: Analyze trading pair\n' +
      '- analyze-portfolio: Analyze portfolio\n' +
      '- analyze-news: Get news analysis\n\n' +
      'Run `npm start -- --help` for details.'
    );
  });

  console.log('Telegram bot started successfully.');
}
