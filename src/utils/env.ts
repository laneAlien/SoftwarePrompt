export function validateEnv(requiredKeys: string[] = []): void {
  const missing = requiredKeys.filter((key) => !process.env[key]);
  if (missing.length) {
    console.warn(
      `Missing environment variables: ${missing.join(', ')}. KuCoin passphrase is the string you set when creating the API key (not your trading password).`
    );
  }

  const warnEmpty = ['GATE_API_KEY', 'GATE_API_SECRET', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'];
  for (const key of warnEmpty) {
    if (key in process.env && !process.env[key]) {
      console.warn(`${key} is defined but empty. Please populate it to enable the related integration.`);
    }
  }
}

