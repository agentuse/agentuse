import chalk from 'chalk';
import { version } from '../../package.json';

export const ASCII_LOGO = `
   ██    ██████  ███████ ███    ██ ████████ ██    ██ ███████ ███████
  ████  ██       ██      ████   ██    ██    ██    ██ ██      ██
 ██  ██ ██   ███ █████   ██ ██  ██    ██    ██    ██ ███████ █████
██    ████    ██ ██      ██  ██ ██    ██    ██    ██      ██ ██
██    ██ ██████  ███████ ██   ████    ██     ██████  ███████ ███████
`;

export type BrandingStyle = 'full' | 'compact';

export function printLogo(style: BrandingStyle = 'full'): void {
  if (style === 'compact') {
    console.error(chalk.bold(`AGENTUSE`) + chalk.gray(` v${version}`));
  } else {
    console.error(ASCII_LOGO);
  }
}
