"""Synthetic mock-desktop traces for three workflows, with UI layout variants.

Variants 0-2 are the "seen" layouts (train and test draw from them); variant 3
renames key controls and reorders everything, as a layout-shift holdout. Every
trace is generated from a seed, so a bundle is reproducible byte for byte.
Nothing here touches a real site: apps are mock names and URLs end in .mock.
"""

import random
from datetime import datetime, timedelta, timezone

from .bundle import build_bundle, seal_episode

PACE_MS = 3000
TASKS = ["email.reply_draft", "reddit.post_compose", "linkedin.notifications_review"]
PEOPLE = ["Dana", "Sam", "Lee", "Ari", "Kim", "Noor", "Jo", "Pat", "Ravi", "Mei", "Uma", "Tom"]
SUBJECTS = ["Lunch?", "Invoice 1042", "Re: roadmap", "Weekend plans", "Quick question", "Design review", "Flight details", "Team offsite", "Contract draft", "Hiring update"]
SUBS = ["r/selfhosted", "r/rust", "r/homelab", "r/linux", "r/python", "r/webdev", "r/sysadmin", "r/devops"]
EVENTS = ["commented on your post", "liked your comment", "viewed your profile", "mentioned you", "shared your post", "endorsed you"]

EMAIL_V = [
    dict(inbox="Inbox", unread="Unread", reply="Reply", draft="Save draft", body="Message body", compose="Compose"),
    dict(inbox="Mail", unread="New", reply="Reply", draft="Save as draft", body="Write your reply", compose="New message"),
    dict(inbox="All inboxes", unread="Unread", reply="Reply to sender", draft="Save draft", body="Body", compose="Compose"),
    dict(inbox="Messages", unread="Unseen", reply="Respond", draft="Keep as draft", body="Your message", compose="Write"),
]
REDDIT_V = [
    dict(create="Create post", title="Title", body="Body text (optional)", preview="Preview", post="Post", joined="joined"),
    dict(create="New post", title="Title", body="Text", preview="Preview", post="Publish", joined="joined"),
    dict(create="Create a post", title="Post title", body="Body", preview="Preview post", post="Post", joined="member"),
    dict(create="Start a thread", title="Headline", body="Post text", preview="See preview", post="Submit post", joined="subscribed"),
]
LINKEDIN_V = [
    dict(notif="Notifications", new="New", end="No more new notifications"),
    dict(notif="Notifications", new="Unread", end="You're all caught up"),
    dict(notif="Alerts", new="New", end="No more new notifications"),
    dict(notif="Activity", new="Fresh", end="Nothing new"),
]


class Trace:
    def __init__(self, rng):
        self.rng = rng
        self.t = 0
        self.steps = []

    def add(self, obs, action, dt=None):
        if self.steps:
            self.t += dt if dt is not None else int(self.rng.lognormvariate(6.7, 0.45))
        self.steps.append({"t_ms": self.t, "observation": obs, "action": action, "result": {"status": "ok"}})

    def maybe_loading(self, app, url, p=0.45):
        if self.rng.random() < p:
            self.add({"app": app, "url_pattern": url, "loading": True, "elements": [{"role": "progressbar", "name": "Loading"}]},
                     {"type": "wait"}, dt=self.rng.randint(120, 400))
            return self.rng.randint(500, 1600)
        return None


def _el(role, name):
    return {"role": role, "name": name}


def _shuffle(rng, xs):
    xs = list(xs)
    rng.shuffle(xs)
    return xs


def gen_email(rng, v):
    V = EMAIL_V[v]
    tr = Trace(rng)
    home = [_el("link", V["inbox"]), _el("link", "Sent"), _el("link", "Drafts"), _el("button", V["compose"])]
    home += [_el("link", n) for n in rng.sample(["Spam", "Archive", "Settings", "Calendar", "Contacts"], rng.randint(0, 3))]
    inbox = _el("link", V["inbox"])
    tr.add({"app": "mail", "url_pattern": "mail://home", "elements": _shuffle(rng, home)}, {"type": "click", "target": inbox})
    wait = tr.maybe_loading("mail", "mail://inbox")
    people = rng.sample(PEOPLE, rng.randint(3, 7))
    rows = [_el("row", f"From {p}: {rng.choice(SUBJECTS)}") for p in people]
    k = rng.randrange(len(rows))
    rows[k] = _el("row", f"{V['unread']} · {rows[k]['name']}")
    chrome = [_el("button", V["compose"]), inbox]
    if rng.random() < 0.2:
        # The unread message starts below the fold: the visible rows hold no unread marker, so scroll first.
        above = [_el("row", f"From {p}: {rng.choice(SUBJECTS)}") for p in rng.sample(PEOPLE, 4)]
        tr.add({"app": "mail", "url_pattern": "mail://inbox", "elements": above + chrome}, {"type": "scroll", "amount": 3}, dt=wait)
        wait = None
    tr.add({"app": "mail", "url_pattern": "mail://inbox", "elements": rows + chrome}, {"type": "click", "target": rows[k]}, dt=wait)
    msg = _shuffle(rng, [_el("button", V["reply"]), _el("button", "Forward"), _el("button", "Archive"), _el("button", "Delete"), _el("button", "Mark unread")])
    tr.add({"app": "mail", "url_pattern": "mail://message", "elements": msg + [_el("text", f"From {people[k]}")]}, {"type": "click", "target": _el("button", V["reply"])})
    body = _el("textbox", V["body"])
    compose = _shuffle(rng, [body, _el("button", "Send"), _el("button", V["draft"]), _el("button", "Discard"), _el("button", "Attach")])
    tr.add({"app": "mail", "url_pattern": "mail://compose", "focus": body, "elements": compose},
           {"type": "type", "target": body, "text_redacted": True}, dt=rng.randint(300, 900))
    tr.add({"app": "mail", "url_pattern": "mail://compose", "focus": body, "elements": compose},
           {"type": "click", "target": _el("button", V["draft"])}, dt=rng.randint(4000, 30000))
    tr.add({"app": "mail", "url_pattern": "mail://compose", "elements": [_el("text", "Draft saved"), inbox]}, {"type": "done"})
    return tr.steps, "low", "Reply to the unread message and save the reply as a draft"


def gen_reddit(rng, v):
    V = REDDIT_V[v]
    tr = Trace(rng)
    subs = rng.sample(SUBS, rng.randint(3, 5))
    j = rng.randrange(len(subs))
    links = [_el("link", s if i != j else f"{s} ({V['joined']})") for i, s in enumerate(subs)]
    tr.add({"app": "browser", "url_pattern": "reddit.mock/", "elements": _shuffle(rng, links + [_el("textbox", "Search")])}, {"type": "click", "target": links[j]})
    wait = tr.maybe_loading("browser", "reddit.mock/r/*")
    posts = [_el("link", f"Post: {rng.choice(SUBJECTS)}") for _ in range(rng.randint(2, 4))]
    sub_page = _shuffle(rng, [_el("button", V["create"]), _el("button", "Joined"), _el("link", "Hot"), _el("link", "New"), _el("link", "Top")] + posts)
    tr.add({"app": "browser", "url_pattern": "reddit.mock/r/*", "elements": sub_page}, {"type": "click", "target": _el("button", V["create"])}, dt=wait)
    title, body = _el("textbox", V["title"]), _el("textbox", V["body"])
    form = _shuffle(rng, [title, body, _el("button", V["preview"]), _el("button", V["post"]), _el("button", "Save draft"), _el("link", "Rules")])
    tr.add({"app": "browser", "url_pattern": "reddit.mock/r/*/submit", "focus": title, "elements": form}, {"type": "type", "target": title, "text_redacted": True})
    tr.add({"app": "browser", "url_pattern": "reddit.mock/r/*/submit", "focus": title, "elements": form}, {"type": "type", "target": body, "text_redacted": True}, dt=rng.randint(2000, 9000))
    tr.add({"app": "browser", "url_pattern": "reddit.mock/r/*/submit", "focus": body, "elements": form}, {"type": "click", "target": _el("button", V["preview"])}, dt=rng.randint(5000, 40000))
    prev = _shuffle(rng, [_el("button", V["post"]), _el("button", "Edit"), _el("text", "Preview")])
    # Pacing rule: post only once PACE_S seconds have passed since opening the preview. The screen
    # does not change while waiting, so only accumulated elapsed time (irregularly sampled) decides.
    obs = {"app": "browser", "url_pattern": "reddit.mock/r/*/submit", "elements": prev}
    gap = int(rng.uniform(250, 2600))
    elapsed = gap
    while elapsed < PACE_MS:
        tr.add(obs, {"type": "wait"}, dt=gap)
        gap = int(rng.uniform(250, 2600))
        elapsed += gap
    tr.add(obs, {"type": "post", "target": _el("button", V["post"])}, dt=gap)
    tr.add({"app": "browser", "url_pattern": "reddit.mock/r/*/comments/*", "elements": [_el("text", "Posted"), _el("link", "Hot")]}, {"type": "done"})
    return tr.steps, "medium", "Compose a post in the joined subreddit, preview it, then publish (needs approval)"


def gen_linkedin(rng, v):
    V = LINKEDIN_V[v]
    tr = Trace(rng)
    notif = _el("link", V["notif"])
    feed = [_el("link", "Home"), _el("link", "My Network"), _el("link", "Jobs"), notif, _el("link", "Messaging")]
    feed += [_el("article", f"{rng.choice(PEOPLE)} posted: {rng.choice(SUBJECTS)}") for _ in range(rng.randint(2, 3))]
    tr.add({"app": "browser", "url_pattern": "linkedin.mock/feed", "elements": _shuffle(rng, feed)}, {"type": "click", "target": notif})
    wait = tr.maybe_loading("browser", "linkedin.mock/notifications")
    pages = rng.randint(1, 4)
    for _ in range(pages):
        items = [_el("listitem", f"{rng.choice(PEOPLE)} {rng.choice(EVENTS)}") for _ in range(rng.randint(3, 4))]
        tr.add({"app": "browser", "url_pattern": "linkedin.mock/notifications", "elements": items + [notif]}, {"type": "scroll", "amount": 5}, dt=wait)
        wait = None
    items = [_el("listitem", f"{rng.choice(PEOPLE)} {rng.choice(EVENTS)}") for _ in range(rng.randint(2, 3))]
    k = rng.randrange(len(items))
    items[k] = _el("listitem", f"{V['new']} · {items[k]['name']}")
    tr.add({"app": "browser", "url_pattern": "linkedin.mock/notifications", "elements": items + [_el("text", V["end"]), notif]}, {"type": "click", "target": items[k]})
    tr.add({"app": "browser", "url_pattern": "linkedin.mock/notifications/*", "elements": [_el("button", "Like"), _el("button", "Reply"), _el("text", items[k]["name"])]}, {"type": "done"})
    return tr.steps, "low", "Open notifications, scroll to the end of the new ones and open the newest"


GENERATORS = {"email.reply_draft": gen_email, "reddit.post_compose": gen_reddit, "linkedin.notifications_review": gen_linkedin}
APPS = {"email.reply_draft": "mail", "reddit.post_compose": "browser", "linkedin.notifications_review": "browser"}


def make_episodes(per_task=160, seed=7, variants=(0, 1, 2), prefix="syn"):
    base = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)
    out = []
    for ti, task in enumerate(TASKS):
        rng = random.Random(f"{seed}:{task}:{prefix}")
        for i in range(per_task):
            v = variants[i % len(variants)]
            steps, risk, goal = GENERATORS[task](rng, v)
            short = task.split(".")[0]
            ep = {
                "episode_id": f"ep_{prefix}_{short}_{seed}_{i:04d}",
                "task": task,
                "created_at": (base + timedelta(minutes=ti * 10000 + i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "split_group": f"{short}-s{i // 4}",
                "variant": f"v{v}",
                "capture": {"consent_id": "synthetic", "redaction_profile": "strict", "device_local": True, "source": "synthetic", "app_scope": [APPS[task]]},
                "steps": steps,
                "labels": {"success": True, "reviewed": True, "risk": risk, "goal": goal},
            }
            out.append(seal_episode(ep))
    return out


def make_bundle(per_task=160, seed=7, shifted=False):
    variants = (3,) if shifted else (0, 1, 2)
    prefix = "shift" if shifted else "syn"
    eps = make_episodes(per_task, seed, variants, prefix)
    consent = {"consent_id": "synthetic", "purposes": ["model_training", "evaluation"], "granted_at": "2026-10-25T12:00:00Z"}
    return build_bundle(
        eps,
        dataset_id=f"ds_{prefix}_{seed}_{per_task}",
        created_at="2026-10-25T12:00:00Z",
        consent=consent,
        name="Synthetic mock desktop traces" + (" (layout shift)" if shifted else ""),
        seed=seed,
        validation=0.0 if shifted else 0.15,
        test=1.0 if shifted else 0.25,
    )
