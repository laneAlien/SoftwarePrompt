import { spawn } from 'child_process';
import fs from 'fs';
import { promises as fsp } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

type SmokeStep = {
  label: string;
  args: string[];
  requiresNetwork?: boolean;
};

function resolveTsxBin(): string {
  const binName = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const localBin = path.join(process.cwd(), 'node_modules', '.bin', binName);
  return fs.existsSync(localBin) ? localBin : binName;
}

function runCommand(label: string, command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`▶️ ${label}`);
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ ${label}`);
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code ?? 'unknown'}`));
      }
    });
  });
}

async function hasNetwork(timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '1.1.1.1', port: 53 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function writeMockNewsConfig(): Promise<string> {
  const configPath = path.join(os.tmpdir(), 'crypto-ai-smoke-news.json');
  const payload = JSON.stringify({ news: { rss: [] } }, null, 2);
  await fsp.writeFile(configPath, payload, 'utf-8');
  return configPath;
}

async function main(): Promise<void> {
  const tsxBin = resolveTsxBin();
  const mockNewsConfig = await writeMockNewsConfig();
  const online = await hasNetwork();

  const steps: SmokeStep[] = [
    {
      label: 'sim:simulate',
      args: [
        'src/cli.ts',
        'sim:simulate',
        '--symbol',
        'BTCUSDT',
        '--timeframe',
        '1m',
        '--candles',
        '30',
        '--initial-price',
        '50000',
        '--no-llm',
      ],
    },
    {
      label: 'sim:trade-sim',
      args: [
        'src/cli.ts',
        'sim:trade-sim',
        '--symbol',
        'BTCUSDT',
        '--timeframe',
        '1m',
        '--candles',
        '60',
        '--initial-price',
        '50000',
        '--no-llm',
      ],
    },
    {
      label: 'risk:calc',
      args: [
        'src/cli.ts',
        'risk:calc',
        '--symbol',
        'BTC/USDT',
        '--side',
        'long',
        '--entry',
        '50000',
        '--balance',
        '1000',
        '--risk',
        '0.01',
        '--leverage',
        '2',
        '--stop',
        '48000',
        '--no-llm',
      ],
    },
    {
      label: 'analysis:analyze-pair',
      requiresNetwork: true,
      args: [
        'src/cli.ts',
        'analysis:analyze-pair',
        '--exchange',
        'gate',
        '--symbol',
        'BTC/USDT',
        '--timeframe',
        '1h',
        '--limit',
        '50',
        '--no-llm',
      ],
    },
    {
      label: 'analysis:analyze-news',
      args: ['src/cli.ts', 'analysis:analyze-news', '--config', mockNewsConfig, '--no-llm'],
    },
  ];

  for (const step of steps) {
    if (step.requiresNetwork && !online) {
      console.log(`⏭️ Skipped ${step.label} (no network)`);
      continue;
    }
    await runCommand(step.label, tsxBin, step.args);
  }
}

main().catch((error) => {
  console.error('Smoke run failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
