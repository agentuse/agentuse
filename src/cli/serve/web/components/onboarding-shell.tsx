import type { ComponentChildren } from 'preact';

export interface OnboardingStepItem {
  number: string;
  title: string;
  detail: string;
  current?: boolean;
}

export function firstUsefulAgentSetupSteps(options: {
  currentStep: 1 | 2 | 3 | 4;
  flow?: 'choose' | 'new' | 'existing';
  projectDetail?: string;
  providerReady?: boolean;
  scanDetail?: string;
  createDetail?: string;
  runDetail?: string;
}): OnboardingStepItem[] {
  if (options.flow === 'new') {
    return [
      { number: '01', title: 'Create project', detail: options.projectDetail ?? 'Empty workspace', current: options.currentStep === 1 },
      { number: '02', title: 'Connect model', detail: options.providerReady ? 'Ready' : 'Required', current: options.currentStep === 2 },
      { number: '03', title: 'Create agent', detail: options.createDetail ?? 'Describe the job', current: options.currentStep === 3 },
      { number: '04', title: 'Run agent', detail: options.runDetail ?? 'Test before scheduling', current: options.currentStep === 4 },
    ];
  }

  return [
    {
      number: '01',
      title: options.flow === 'existing' ? 'Add existing project' : 'Choose project',
      detail: options.projectDetail ?? (options.flow === 'existing' ? 'Use its files' : 'New or existing'),
      current: options.currentStep === 1,
    },
    { number: '02', title: 'Connect model', detail: options.providerReady ? 'Ready' : 'Required', current: options.currentStep === 2 },
    { number: '03', title: 'Find work', detail: options.scanDetail ?? '3 grounded ideas', current: options.currentStep === 3 },
    { number: '04', title: 'Create and run', detail: options.createDetail ?? 'Review before scheduling', current: options.currentStep === 4 },
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
