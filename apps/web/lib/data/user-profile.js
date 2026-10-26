import "server-only";
import { createProfileStore } from "@profullstack/profile";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The shared @profullstack/profile fields (email, first/last name, company
 * domain, job title, LinkedIn) for a Supabase auth account, in
 * public.user_profiles keyed by the auth user id. Service-role only.
 */
export function userProfileStore() {
    return createProfileStore(getSupabaseServerClient(), { table: "user_profiles", key: "user_id" });
}
