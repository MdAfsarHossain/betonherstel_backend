import { addressSchema } from "../inquiry/inquiry.validation";
import { InquiryService } from "../inquiry/inquiry.service";
import { ICreateInquiry } from "../inquiry/inquiry.interface";

const clean = (v?: string | null) => (v && v.trim() ? v.trim() : undefined);
// Like clean, but for loose input: a number (house number 50) becomes "50", anything else that is not text is ignored
const text = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "string" ? clean(v) : undefined);

// Creates an inquiry from the website form. Goes through the same entry point as every other
// source, so the customer is linked or created, the inquiry numbered, the confirmation email
// sent and the office notified exactly as for the webhook and the portal.
const createInquiry = async (body: any, files: any[], ip?: string) => {
  // A bot filled the hidden field: answer like a success, create nothing
  if (clean(body.website)) {
    return { created: false as const, reference: null, ignored: true };
  }

  let description = clean(body.description) ?? "";

  // The address may come as one object ("address": { street, ... }, JSON or a JSON string in a
  // multipart form) or as separate fields; the object wins where both are given
  let nested: any = body.address;
  if (typeof nested === "string") {
    try {
      nested = JSON.parse(nested);
    } catch {
      nested = null;
    }
  }
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) nested = {};

  const parts = {
    street: text(nested.street ?? body.street),
    house_number: text(nested.house_number ?? body.house_number),
    postcode: text(nested.postcode ?? body.postcode),
    city: text(nested.city ?? body.city),
    country: text(nested.country ?? body.country),
  };

  // An incomplete or invalid address is kept as text instead of refusing the lead
  let address: ICreateInquiry["address"] = null;
  if (Object.values(parts).some(Boolean)) {
    const parsed = addressSchema.safeParse(parts);
    if (parsed.success) {
      address = parsed.data;
    } else {
      const line = [
        parts.street,
        parts.house_number,
        parts.postcode,
        parts.city,
        parts.country,
      ]
        .filter(Boolean)
        .join(" ");
      description = [description, `Address given on the website: ${line}`]
        .filter(Boolean)
        .join("\n\n");
    }
  }

  const input: ICreateInquiry = {
    source: "FORM",
    contact_name: body.contact_name,
    contact_email: clean(body.contact_email) ?? null,
    contact_phone: clean(body.contact_phone) ?? null,
    company_name: clean(body.company_name),
    service_type: clean(body.service_type) ?? null,
    description: description || null,
    address,
    language: body.language,
    external_ref: clean(body.submission_id),
  };

  let result: any;
  try {
    result = await InquiryService.createInquiry(input, null);
  } catch (error: any) {
    // An unknown service type must not lose the lead: keep it in the description
    if (input.service_type && /service type/i.test(String(error?.message))) {
      const note = `Service requested on the website: ${input.service_type}`;
      result = await InquiryService.createInquiry(
        {
          ...input,
          service_type: null,
          description: [input.description, note].filter(Boolean).join("\n\n"),
        },
        null,
      );
    } else {
      throw error;
    }
  }

  if (result.created === false) {
    // The same submission twice: answer as before, make nothing new
    return {
      created: false as const,
      reference: result.inquiry?.reference ?? null,
      ignored: false,
    };
  }

  // Photos are added afterwards; a bad file never undoes the inquiry
  let photosAdded = 0;
  let photosError: string | null = null;
  if (files.length > 0) {
    try {
      await InquiryService.addPhotos(result.inquiry.id, files, null);
      photosAdded = files.length;
    } catch (error: any) {
      photosError = error?.message ?? "The files could not be saved!";
      console.error("❌ Website form photos failed:", photosError, ip ?? "");
    }
  }

  return {
    created: true as const,
    reference: (result.inquiry?.reference ?? null) as string | null,
    ignored: false,
    photos_added: photosAdded,
    photos_error: photosError,
  };
};

export const PublicInquiryService = { createInquiry };
