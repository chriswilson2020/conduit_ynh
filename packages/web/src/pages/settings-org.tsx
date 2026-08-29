import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  MAX_LOGO_BYTES, ORG_PROFILE_RESERVE_BYTES, logoDataUriProblem, orgProfileBytes,
} from "@conduit/shared";
import type { OrgProfileInput } from "@conduit/shared";
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
 * THE BOUND IS 32KB ON THE IMAGE, refused HERE with a sentence rather than
 * weeks later as a quote that will not render. The reasoning is arithmetic
 * somebody has to have done: the logo reaches the renderer inlined at 4/3 of
 * its stored size against a 128KB input cap, so a stored logo much above 64KB
 * cannot render at all, and the template and the line items have to fit beside
 * it. 32KB leaves the document itself three quarters of the budget.
 *
 * `saveOrgProfile` enforces the same bound server-side and is the control; this
 * is the message.
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

  // The server's row is the initial value, once. Not a controlled mirror of the
  // query: re-seeding on every refetch would overwrite what somebody is typing,
  // which is the bug the mail settings page's own form avoids the same way.
  useEffect(() => {
    if (profile === undefined) return;
    setForm({
      name: profile.name, addressLines: profile.addressLines, vatNumber: profile.vatNumber,
      registrationNumber: profile.registrationNumber, email: profile.email, phone: profile.phone,
      website: profile.website, bankDetails: profile.bankDetails, logoDataUri: profile.logoDataUri,
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
    // which is the half that had to be right: a 32,768-byte image and a
    // 32,769-byte one produce the same 43,692 base64 characters and differ only
    // in padding, so a character count cannot tell them apart at all.
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

  // The reserve counts the logo and the eight text fields TOGETHER, because
  // they compete for the same share of the render budget -- a maxed ASCII
  // profile is 47,320 bytes and the same fields full of ampersands are 60,920,
  // which is why the server enforces this rather than hoping for it.
  const used = orgProfileBytes(form);
  const over = used > ORG_PROFILE_RESERVE_BYTES;
  const pending = save.isPending;

  return (
    <SettingsLayout>
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
            maxLength={200}
            disabled={pending}
            data-testid="org-name"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Address
          <Textarea
            value={form.addressLines}
            maxLength={2000}
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
              maxLength={100}
              disabled={pending}
              data-testid="org-vat"
              onChange={(event) => patch({ vatNumber: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Registration number
            <Input
              value={form.registrationNumber}
              maxLength={100}
              disabled={pending}
              data-testid="org-registration"
              onChange={(event) => patch({ registrationNumber: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Email
            <Input
              value={form.email}
              maxLength={200}
              disabled={pending}
              data-testid="org-email"
              onChange={(event) => patch({ email: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Phone
            <Input
              value={form.phone}
              maxLength={100}
              disabled={pending}
              data-testid="org-phone"
              onChange={(event) => patch({ phone: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Website
            <Input
              value={form.website}
              maxLength={200}
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
            maxLength={500}
            rows={3}
            disabled={pending}
            data-testid="org-bank"
            onChange={(event) => patch({ bankDetails: event.target.value })}
          />
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
              document sanitiser nor the renderer's fetcher looks. The server's
              mime check refuses it too.
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
            PNG, JPEG, GIF or WEBP, at most {MAX_LOGO_BYTES} bytes. The logo is inlined
            into the PDF at four thirds of its stored size, so a larger one leaves no
            room for the quote itself.
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
            ? `${String(used - ORG_PROFILE_RESERVE_BYTES)} bytes over the ${String(ORG_PROFILE_RESERVE_BYTES)} a quote reserves for its issuer.`
            : `${String(used)} of ${String(ORG_PROFILE_RESERVE_BYTES)} bytes of a quote's issuer reserve.`}
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
