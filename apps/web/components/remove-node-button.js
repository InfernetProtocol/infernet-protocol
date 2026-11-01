"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RemoveNodeButton({ pubkey, role, name }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function removeNode() {
        const detail = role === "provider"
            ? " This archives the node and preserves its history. Nodes with unpaid earnings or unsettled credits cannot be removed."
            : "";
        if (!window.confirm(`Remove ${name} from the Infernet registry?${detail}`)) return;

        setBusy(true);
        setError("");
        try {
            const response = await fetch(`/api/v1/user/nodes/${encodeURIComponent(pubkey)}?role=${encodeURIComponent(role)}`, {
                method: "DELETE"
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error ?? "Could not remove this node.");
            router.refresh();
        } catch (err) {
            setError(err?.message ?? "Could not remove this node.");
            setBusy(false);
        }
    }

    return (
        <div className="flex shrink-0 flex-col items-end gap-1">
            <button
                type="button"
                onClick={removeNode}
                disabled={busy}
                className="rounded-full border border-red-400/30 px-3 py-1.5 text-xs font-medium text-red-200 transition hover:border-red-300/70 hover:bg-red-400/10 disabled:opacity-50"
            >
                {busy ? "Removing…" : role === "provider" ? "Archive" : "Delete"}
            </button>
            {error ? <p role="alert" className="max-w-48 text-right text-xs text-red-200">{error}</p> : null}
        </div>
    );
}
