import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  DEFAULT_TIME_ZONE, MAX_LOGO_BYTES, MAX_LOGO_PIXELS, ORG_PROFILE_FIELD_CAPS,
  ORG_PROFILE_TEXT_RESERVE_BYTES, formatDocumentInstant, logoDataUriProblem,
  orgProfileTextBytes, timeZoneProblem,
} from "@conduit/shared";
import type { OrgProfileInput } from "@conduit/shared";
import { supportedTimeZones, timeZoneOptions } from "./settings-org-lib";
import { useOrgProfile, useSaveOrgProfile } from "../queries";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";

/**
 * THE ISSUER PROFILE: who a quote is FROM.
 *
 * Conduit had nowhere to record your own company before this phase, and every
 * other part of it depends on this row -- a quote needs a name, an address, a
 * VAT number and a logo at the top of the page.
 *
 * A SINGLETON EDITED AS ONE FORM, saved with PUT rather than PATCH. There is
 * one row, no concurrent editors, and clearing a field has to be expressible;
 * sending the whole form is both the simplest contract and the only one in
 * which "delete my phone number" is a thing you can say.
 */

const EMPTY: OrgProfileInput = {
  name: "", addressLines: "", vatNumber: "", registrationNumber: "",
  email: "", phone: "", website: "", bankDetails: "", logoDataUri: "",
  // NOT "", unlike every field beside it. This value is only on screen for the
  // moment before the query resolves, but a `<select>` whose value matches no
  // option renders EMPTY and submits its first option, so "" here would be a
  // control that silently means Africa/Abidjan.
  timeZone: DEFAULT_TIME_ZONE,
};

/**
 * THE LOGO IS THE BYTES, NOT A FILE ID, and this is where that is enforced for
 * the person doing the uploading.
 *
 * It is a `data:` URI column on `org_profile` rather than a `files` row --
 * `files_exactly_one_entity` requires every file to belong to exactly one
 * company, contact, deal or project, and an issuer's logo belongs to none of
 * them, so there was no legal row for it to be. Reading it as a data URI here
 * is therefore not a workaround: it is the storage format, and the renderer
 * accepts nothing else anyway.
 *
 * THE BOUND IS 300KB AND 16 MEGAPIXELS ON THE IMAGE, refused HERE with a
 * sentence rather than weeks later as a quote that will not render.
 *
 * IT WAS 32KB IN v1.0.0 AND THAT WAS TOO SMALL FOR A REAL LOGO. The arithmetic
 * that produced it was sound for its time: the logo reaches the renderer
 * inlined at 4/3 of its stored size against what was then a 131,072-byte input
 * cap shared with the document's own text, so 32KB took a third of it and
 * anything much larger left no room for the quote. v1.0.1 stopped making them
 * share -- the image payload has its own allowance now -- so the file bound is
 * 300KB and what limits it is the machine rather than the paragraph beside it.
 *
 * THE PIXEL BOUND IS THE ONE THE FILE SIZE CANNOT MAKE. A PNG's decoded raster
 * is width x height x 4 whatever the file compressed to, so a 12KB file can be
 * 10,000 x 10,000 and cost the renderer half a gigabyte.
 *
 * `saveOrgProfile` enforces the same bounds server-side and is the control;
 * this is the message.
 */
function readLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("that file could not be read"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

export function SettingsOrgPage() {
  const { data: profile, isLoading, error } = useOrgProfile();
  const save = useSaveOrgProfile();
  const [form, setForm] = useState<OrgProfileInput>(EMPTY);
  const [logoProblem, setLogoProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const seeded = useRef(false);

  /**
   * The server's row is the initial value, ONCE, and the ref is what makes that
   * true rather than merely intended.
   *
   * The first version of this said the same thing with the same comment and did
   * not do it: the effect depends on `profile`, which is a fresh object every
   * time the query resolves, so any refetch -- a window refocus is enough --
   * re-ran the body and overwrote the form. It was invisible because TanStack's
   * structural sharing hands back the SAME object when the bytes have not
   * changed, so it only bit when someone else had edited the profile, which is
   * exactly when clobbering an in-progress edit is worst.
   */
  useEffect(() => {
    if (profile === undefined || seeded.current) return;
    seeded.current = true;
    setForm({
      name: profile.name, addressLines: profile.addressLines, vatNumber: profile.vatNumber,
      registrationNumber: profile.registrationNumber, email: profile.email, phone: profile.phone,
      website: profile.website, bankDetails: profile.bankDetails, logoDataUri: profile.logoDataUri,
      timeZone: profile.timeZone,
    });
  }, [profile]);

  function patch(over: Partial<OrgProfileInput>) {
    setSaved(false);
    setForm((current) => ({ ...current, ...over }));
  }

  async function handleLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the picker so choosing the SAME file twice fires a change event
    // again -- otherwise a rejected logo cannot be re-picked after shrinking it.
    event.target.value = "";
    if (file === undefined) return;
    setSaved(false);
    let uri: string;
    try {
      uri = await readLogo(file);
    } catch (readError) {
      setLogoProblem(readError instanceof Error ? readError.message : String(readError));
      return;
    }
    // The SHARED check, so the message here and the server's refusal are one
    // answer. It rejects on the DECODED size rather than the string length,
    // which is the half that had to be right: a 307,200-byte image and a
    // 307,201-byte one produce the same 409,600 base64 characters and differ
    // only in padding, so a character count cannot tell them apart at all.
    //
    // It also refuses a picture with too many PIXELS, which is the half a size
    // check cannot make at all: 12,227 bytes of PNG can be 10,000 x 10,000.
    const problem = logoDataUriProblem(uri);
    if (problem !== null) {
      setLogoProblem(problem);
      return;
    }
    setLogoProblem(null);
    patch({ logoDataUri: uri });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    save.mutate(form, { onSuccess: () => setSaved(true) });
  }

  // THE RESERVE IS THE TEXT ONLY SINCE v1.0.1, and that is the change: the logo
  // used to be added into this same figure, so every byte of picture came out
  // of the address. The eight fields cap at 3,400 characters, which is 3,400
  // bytes of ASCII and 17,000 with an ampersand in every position (an `&`
  // escapes to five), which is why the server enforces this rather than hoping.
  const used = orgProfileTextBytes(form);
  const over = used > ORG_PROFILE_TEXT_RESERVE_BYTES;
  const pending = save.isPending;

  // The platform's list is stable for the life of the page; the OPTIONS are not,
  // because an unrecognised stored zone has to stay selectable -- see the lib.
  const supported = useMemo(() => supportedTimeZones(), []);
  const zoneOptions = useMemo(
    () => timeZoneOptions(form.timeZone, supported), [form.timeZone, supported],
  );
  const zoneProblem = timeZoneProblem(form.timeZone);
  // WHAT A DOCUMENT WOULD SAY, RIGHT NOW, in the zone currently selected. This is
  // the one control on the form whose effect is invisible until a PDF exists, and
  // it calls the same function the renderer does -- so it is the preview rather
  // than a description of one. It also shows the FALLBACK: choose a zone that no
  // longer resolves and this reads UTC, which is exactly what would be printed.
  const zonePreview = formatDocumentInstant(new Date().toISOString(), form.timeZone);

  return (
    <SettingsLayout title="Organisation">
      <form data-testid="org-settings" onSubmit={handleSubmit} className="flex max-w-2xl flex-col gap-4">
        <h2 className="text-sm font-semibold text-slate-900">Organisation</h2>
        <p className="text-xs text-slate-500">
          Who a quote is from. These details and the logo are printed at the top of every
          document, and a document keeps the details it was issued with.
        </p>

        {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">Could not load the profile: {error.message}</p>
        )}

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Name
          <Input
            value={form.name}
            maxLength={ORG_PROFILE_FIELD_CAPS.name}
            disabled={pending}
            data-testid="org-name"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Address
          <Textarea
            value={form.addressLines}
            maxLength={ORG_PROFILE_FIELD_CAPS.addressLines}
            rows={4}
            disabled={pending}
            data-testid="org-address"
            onChange={(event) => patch({ addressLines: event.target.value })}
          />
          <span className="text-xs font-normal text-slate-400">
            One line per line. The template prints line breaks as written.
          </span>
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            VAT number
            <Input
              value={form.vatNumber}
              maxLength={ORG_PROFILE_FIELD_CAPS.vatNumber}
              disabled={pending}
              data-testid="org-vat"
              onChange={(event) => patch({ vatNumber: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Registration number
            <Input
              value={form.registrationNumber}
              maxLength={ORG_PROFILE_FIELD_CAPS.registrationNumber}
              disabled={pending}
              data-testid="org-registration"
              onChange={(event) => patch({ registrationNumber: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Email
            <Input
              value={form.email}
              maxLength={ORG_PROFILE_FIELD_CAPS.email}
              disabled={pending}
              data-testid="org-email"
              onChange={(event) => patch({ email: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Phone
            <Input
              value={form.phone}
              maxLength={ORG_PROFILE_FIELD_CAPS.phone}
              disabled={pending}
              data-testid="org-phone"
              onChange={(event) => patch({ phone: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Website
            <Input
              value={form.website}
              maxLength={ORG_PROFILE_FIELD_CAPS.website}
              disabled={pending}
              data-testid="org-website"
              onChange={(event) => patch({ website: event.target.value })}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Bank details
          <Textarea
            value={form.bankDetails}
            maxLength={ORG_PROFILE_FIELD_CAPS.bankDetails}
            rows={3}
            disabled={pending}
            data-testid="org-bank"
            onChange={(event) => patch({ bankDetails: event.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Timezone
          {/*
            A SELECT RATHER THAN A TEXT FIELD, and that is the control decision.
            Free text cannot be made safe by a message beside it: `CET` is a real
            tzdata name and would be accepted, `+02:00` is accepted by Intl and is
            an hour wrong for half the year, and an ordinary typo is not discovered
            until a document prints. A list the platform itself supplies can
            express none of those.
          */}
          <select
            value={form.timeZone}
            disabled={pending}
            data-testid="org-timezone"
            onChange={(event) => patch({ timeZone: event.target.value })}
            className="min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900"
          >
            {zoneOptions.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
          <span data-testid="org-timezone-preview" className="text-xs font-normal text-slate-400">
            Dates on documents print in this zone, and name it. A document issued
            now would say {zonePreview}.
          </span>
          {zoneProblem !== null && (
            /*
              THE STORED ZONE HAS STOPPED BEING ONE -- a name coined after this
              server's tzdata, or a restore from an install with different tzdata.
              Documents keep rendering, in UTC and saying UTC, and this is where the
              operator finds out why rather than by holding a PDF against a calendar.

              A `<span>` and not a `<p>`, which is the only reason this differs from
              every other refusal on the page: `<label>` takes phrasing content, and
              a block element inside one is markup a browser repairs by closing the
              label early -- which would detach the select from its own caption.
              `role="alert"` carries the announcement either way.
            */
            <span
              role="alert"
              data-testid="org-timezone-problem"
              className="text-sm font-normal text-red-600"
            >
              {zoneProblem}
            </span>
          )}
        </label>

        <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-4">
          <span className="text-xs font-medium text-slate-600">Logo</span>
          {form.logoDataUri === "" ? (
            <p data-testid="org-logo-empty" className="text-sm text-slate-400">
              No logo. A quote prints a plain letterhead without one.
            </p>
          ) : (
            <img
              src={form.logoDataUri}
              alt="The logo printed on a quote"
              data-testid="org-logo-preview"
              className="max-h-24 max-w-full self-start"
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {/*
              SVG IS NOT OFFERED, and that is a decision rather than an oversight
              of the accept list: it is a document format with its own
              URL-bearing elements, arriving inside a data: URI where neither the
              document sanitiser nor the renderer's fetcher looks.

              THIS ATTRIBUTE IS A CONVENIENCE, NOT A CONTROL, and an earlier
              version of this comment claimed the server's mime check backed it
              up -- which was true only of a file honest enough to declare what
              it was. `accept` filters a file picker and nothing else, and the
              type that reaches the data: URI comes from `File.type`, which the
              browser derives from the EXTENSION. An SVG renamed to .png arrived
              as `data:image/png`, passed every check, and was drawn as vector
              art by a renderer that sniffs properly. logoDataUriProblem reads
              the leading bytes now, here and in saveOrgProfile both.
            */}
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50">
              Choose an image
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={pending}
                data-testid="org-logo-input"
                onChange={(event) => void handleLogo(event)}
                className="sr-only"
              />
            </label>
            {form.logoDataUri !== "" && (
              <Button
                variant="outline"
                disabled={pending}
                data-testid="org-logo-remove"
                onClick={() => { setLogoProblem(null); patch({ logoDataUri: "" }); }}
              >
                Remove logo
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">
            PNG, JPEG, GIF or WEBP, at most {MAX_LOGO_BYTES} bytes and{" "}
            {MAX_LOGO_PIXELS} pixels (4000 x 4000, or any other pair that multiplies
            to it). The picture's dimensions matter as much as the file's size: the
            renderer decodes every pixel whatever the file compressed to.
          </p>
          {logoProblem !== null && (
            <p role="alert" data-testid="org-logo-problem" className="text-sm text-red-600">{logoProblem}</p>
          )}
        </div>

        <p
          data-testid="org-budget"
          className={`text-xs ${over ? "font-medium text-red-600" : "text-slate-400"}`}
        >
          {over
            ? `${String(used - ORG_PROFILE_TEXT_RESERVE_BYTES)} bytes over the ${String(ORG_PROFILE_TEXT_RESERVE_BYTES)} a quote reserves for these details.`
            : `${String(used)} of ${String(ORG_PROFILE_TEXT_RESERVE_BYTES)} bytes of a quote's issuer reserve.`}
        </p>

        {save.isError && (
          <p role="alert" data-testid="org-error" className="text-sm text-red-600">{save.error.message}</p>
        )}
        {saved && !save.isError && (
          <p data-testid="org-saved" className="text-sm text-green-700">Saved.</p>
        )}

        <div className="flex justify-end">
          <Button type="submit" data-testid="org-save" disabled={pending}>
            {pending ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </SettingsLayout>
  );
}
