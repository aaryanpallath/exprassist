import type { Tables } from "./lang/eval.js";
import type { Schema } from "./lang/types.js";

// The fields a workflow author can reference in this demo: an agreement routed for review and signature.
export const SCHEMA: Schema = {
  fields: {
    "Agreement.Amount": { type: "number", required: true, description: "total contract value in USD" },
    "Agreement.Type": { type: "text", required: true, description: "kind of agreement", values: ["NDA", "MSA", "SOW", "Order Form", "Amendment"] },
    "Agreement.Region": { type: "text", required: true, description: "sales region", values: ["NA", "EU", "APAC", "LATAM"] },
    "Agreement.TermMonths": { type: "number", required: false, description: "contract length in months (blank if open-ended)" },
    "Agreement.DiscountPct": { type: "number", required: false, description: "discount off list price, 0-100 (blank if none)" },
    "Agreement.AutoRenew": { type: "boolean", required: true, description: "renews automatically" },
    "Agreement.Title": { type: "text", required: true, description: "agreement title" },
    "Counterparty.Name": { type: "text", required: true, description: "the other party's legal name" },
    "Counterparty.Country": { type: "text", required: true, description: "two-letter country code", values: ["US", "DE", "FR", "GB", "JP", "IN", "BR"] },
    "Counterparty.Tier": { type: "text", required: false, description: "customer tier (blank for new customers)", values: ["Strategic", "Enterprise", "Standard"] },
    "Signer.Email": { type: "text", required: true, description: "counterparty signer's email" },
    "Signer.Title": { type: "text", required: false, description: "counterparty signer's job title" },
  },
  tables: {
    Approvers: { key: "region", columns: { Email: "text", Limit: "number" } },
  },
};

export const TABLES: Tables = {
  Approvers: {
    NA: { Email: "na-deals@example.com", Limit: 250000 },
    EU: { Email: "eu-deals@example.com", Limit: 150000 },
    APAC: { Email: "apac-deals@example.com", Limit: 100000 },
    LATAM: { Email: "latam-deals@example.com", Limit: 75000 },
  },
};
