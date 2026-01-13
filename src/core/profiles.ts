export type ProfileName = 'default' | 'promo' | 'safe';

type FeeModel = 'flat' | 'maker-taker';

export interface ProfileDefaults {
  grids: number;
  feeModel: FeeModel;
  slippageRate: number;
  trailStepPercent: number;
  stopOnMa30?: boolean;
  stopOnLowCloses?: number;
}

const profileDefaults: Record<ProfileName, ProfileDefaults> = {
  default: {
    grids: 10,
    feeModel: 'flat',
    slippageRate: 0,
    trailStepPercent: 0,
  },
  promo: {
    grids: 16,
    feeModel: 'flat',
    slippageRate: 0.001,
    trailStepPercent: 0.35,
    stopOnMa30: false,
    stopOnLowCloses: undefined,
  },
  safe: {
    grids: 8,
    feeModel: 'maker-taker',
    slippageRate: 0.002,
    trailStepPercent: 0.15,
    stopOnMa30: true,
    stopOnLowCloses: 2,
  },
};

export function resolveProfileName(value?: string): ProfileName {
  const normalized = (value ?? 'default').toLowerCase();
  if (normalized === 'promo' || normalized === 'safe' || normalized === 'default') {
    return normalized;
  }
  return 'default';
}

export function getProfileDefaults(name?: string): { name: ProfileName; defaults: ProfileDefaults } {
  const resolvedName = resolveProfileName(name);
  return { name: resolvedName, defaults: profileDefaults[resolvedName] };
}
