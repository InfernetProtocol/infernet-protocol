"use client";

import { ProfileFields } from "@profullstack/profile/react";

// Email has its own input; the shared package renders the other five.
const FIELDS = ["first_name", "last_name", "company_domain", "job_title", "linkedin_url"];

/** The shared @profullstack/profile signup fields, posted with the form. */
export default function SignupProfileFields() {
    return <ProfileFields fields={FIELDS} idPrefix="signup-" />;
}
