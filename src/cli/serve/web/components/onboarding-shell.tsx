import type { ComponentChildren } from 'preact';

export interface OnboardingStepItem {
  number: string;
  title: string;
  detail: string;
  current?: boolean;
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
