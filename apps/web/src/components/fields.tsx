import { COUNTRY_CODES } from '@/lib/country-codes';
import { countryName } from '@/lib/format';

/** A labelled text input: label above, optional hint, nothing hidden in placeholders. */
export function TextField({
  name,
  label,
  hint,
  defaultValue,
  type = 'text',
  autoComplete,
  width = 'full',
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string | null;
  type?: 'text' | 'email' | 'tel';
  autoComplete?: string;
  width?: 'full' | 'short';
}) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <div className="field">
      <label className="label" htmlFor={name}>
        {label}
      </label>
      {hint && (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      )}
      <input
        className={width === 'short' ? 'input input-short' : 'input'}
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        autoComplete={autoComplete ?? 'off'}
        spellCheck={false}
        aria-describedby={hintId}
      />
    </div>
  );
}

/**
 * A date as three boxes, day, month and year: easier to type and to read
 * aloud than a date picker. `value` is YYYY-MM-DD.
 */
export function DateFields({ name, legend, hint, value }: { name: string; legend: string; hint?: string; value?: string | null }) {
  const [year, month, day] = value ? value.split('-') : [];
  return (
    <fieldset className="fieldset" aria-describedby={hint ? `${name}-hint` : undefined}>
      <legend>{legend}</legend>
      {hint && (
        <span className="hint" id={`${name}-hint`}>
          {hint}
        </span>
      )}
      <div className="actions">
        {(
          [
            ['day', 'Day', day ? String(Number(day)) : ''],
            ['month', 'Month', month ? String(Number(month)) : ''],
            ['year', 'Year', year ?? ''],
          ] as const
        ).map(([part, label, partValue]) => (
          <div key={part}>
            <label className="label" htmlFor={`${name}-${part}`}>
              {label}
            </label>
            <input
              className="input input-short"
              id={`${name}-${part}`}
              name={`${name}-${part}`}
              inputMode="numeric"
              defaultValue={partValue}
              autoComplete="off"
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** The date from DateFields, as YYYY-MM-DD; null when left empty. */
export function dateFrom(form: FormData, name: string): string | null {
  const [day, month, year] = ['day', 'month', 'year'].map((part) => String(form.get(`${name}-${part}`) ?? '').trim());
  if (!day && !month && !year) {
    return null;
  }
  return `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`;
}

const COUNTRIES = [...COUNTRY_CODES].map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));

/** An address: lines, town, postcode, and a country chosen from the list the API accepts. */
export function AddressFields({
  legend,
  value,
}: {
  legend: string;
  value?: { line1: string; line2: string | null; town: string; postcode: string | null; country: string } | null;
}) {
  return (
    <fieldset className="fieldset">
      <legend>{legend}</legend>
      <span className="hint">Leave it all empty if you do not have it yet.</span>
      <TextField name="line1" label="Address line 1" defaultValue={value?.line1} autoComplete="address-line1" />
      <TextField name="line2" label="Address line 2 (optional)" defaultValue={value?.line2} autoComplete="address-line2" />
      <TextField name="town" label="Town or city" defaultValue={value?.town} autoComplete="address-level2" />
      <TextField name="postcode" label="Postcode (optional)" defaultValue={value?.postcode} autoComplete="postal-code" width="short" />
      <div className="field">
        <label className="label" htmlFor="country">
          Country
        </label>
        <select className="select" id="country" name="country" defaultValue={value?.country ?? 'GB'}>
          {COUNTRIES.map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

/** The address from AddressFields; null when no line or town was given. */
export function addressFrom(form: FormData) {
  const text = (name: string) => String(form.get(name) ?? '').trim();
  if (!text('line1') && !text('line2') && !text('town') && !text('postcode')) {
    return null;
  }
  return {
    line1: text('line1'),
    line2: text('line2') || null,
    town: text('town'),
    postcode: text('postcode') || null,
    country: text('country'),
  };
}

/** A text field's value, or null when left empty, which the API reads as "none". */
export function optionalText(form: FormData, name: string): string | null {
  return String(form.get(name) ?? '').trim() || null;
}
