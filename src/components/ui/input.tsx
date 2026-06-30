import { InputHTMLAttributes, forwardRef } from "react";

/**
 * Drop-in <input> replacement that suppresses browser / password-manager
 * autofill by default. The app has many text fields that look like login or
 * profile fields to Chrome's heuristics (API-key fields, DNS records, repo
 * names, …), so without this they get filled with random saved credentials.
 *
 * - Non-password fields default to autoComplete="off".
 * - Password fields default to "new-password" (Chrome ignores "off" on
 *   type=password, but respects "new-password" to mean "don't fill a saved one").
 * - Generic password-manager opt-out attributes are added so 1Password /
 *   LastPass / Dashlane leave the field alone too.
 *
 * Pass an explicit `autoComplete` to opt a field back into autofill (e.g. a real
 * login form that *should* be filled).
 */
const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ type, autoComplete, ...props }, ref) => {
    const isPassword = type === "password";
    return (
      <input
        ref={ref}
        type={type}
        autoComplete={autoComplete ?? (isPassword ? "new-password" : "off")}
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export { Input };
