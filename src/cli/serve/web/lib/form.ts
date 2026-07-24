/**
 * Spread onto free-text fields (prompts, comments, instructions) so password
 * managers leave them alone. 1Password and friends classify any unlabelled
 * text field inside a <form> as fill-worthy and drop an inline vault list over
 * it, which is noise on a prompt box and hides the field's own placeholder.
 *
 * Each vendor reads its own attribute, hence the set: `autocomplete="off"`
 * alone is widely ignored by extensions.
 */
export const noAutofill = {
  autocomplete: 'off',
  'data-1p-ignore': true,      // 1Password
  'data-lpignore': 'true',     // LastPass
  'data-bwignore': true,       // Bitwarden
  'data-form-type': 'other',   // Dashlane
} as const;
