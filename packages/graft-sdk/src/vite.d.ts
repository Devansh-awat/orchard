import type { UserConfig } from 'vite';

export interface GraftUiOptions {
  entry: string;
  outDir?: string;
  plugins?: UserConfig['plugins'];
}

export function graftUi(options: GraftUiOptions): Promise<UserConfig>;
