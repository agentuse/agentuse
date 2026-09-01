import type { ComponentChildren } from 'preact';

export function SettingsGroup(props: { title: string; children: ComponentChildren }) {
  return (
    <section class="settings-group">
      <h2 class="settings-group-title">{props.title}</h2>
      {props.children}
    </section>
  );
}

export function SettingsRow(props: { label: string; hint?: string; children?: ComponentChildren }) {
  return (
    <div class="settings-row">
      <div class="settings-row-text">
        <div class="settings-row-label">{props.label}</div>
        {props.hint && <div class="settings-row-hint">{props.hint}</div>}
      </div>
      {props.children && <div class="settings-row-control">{props.children}</div>}
    </div>
  );
}
