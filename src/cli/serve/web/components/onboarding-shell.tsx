import type { ComponentChildren } from 'preact';

export interface OnboardingStepItem {
  number: string;
  title: string;
  detail: string;
  current?: boolean;
}

export function firstUsefulAgentSetupSteps(options: {
  currentStep: 1 | 2 | 3 | 4;
  projectDetail?: string;
  providerReady?: boolean;
  scanDetail?: string;
  createDetail?: string;
}): OnboardingStepItem[] {
  return [
    { number: '01', title: 'Choose a project', detail: options.projectDetail ?? 'New or already in progress', current: options.currentStep === 1 },
    { number: '02', title: 'Connect provider', detail: options.providerReady ? 'Provider ready' : 'Required before project scan', current: options.currentStep === 2 },
    { number: '03', title: 'Scan project', detail: options.scanDetail ?? 'Get three grounded suggestions', current: options.currentStep === 3 },
    { number: '04', title: 'Create and run', detail: options.createDetail ?? 'Review Source, then see the result', current: options.currentStep === 4 },
  ];
}

export function OnboardingShell(props: {
  labelledBy: string;
  stepsLabel: string;
  steps: OnboardingStepItem[];
  className?: string;
  compact?: boolean | undefined;
  children: ComponentChildren;
}) {
  const classes = ['onboarding-empty', props.className, props.compact ? 'is-compact' : ''].filter(Boolean).join(' ');
  return (
    <section class={classes} aria-labelledby={props.labelledBy}>
      <div class="onboarding-copy">{props.children}</div>
      <ol class="onboarding-steps" aria-label={props.stepsLabel}>
        {props.steps.map((step) => (
          <li class={step.current ? 'is-current' : ''} key={step.number}>
            <span class="onboarding-step-number">{step.number}</span>
            <span><strong>{step.title}</strong><small>{step.detail}</small></span>
          </li>
        ))}
      </ol>
    </section>
  );
}
