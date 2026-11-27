# Overview (`/dashboard`)

**Reach it:** sign in; the app lands on `/dashboard`. The header's org link and the "Overview" tab lead back to it.

**Drive it:** open it signed in and read the org heading, the usage and document counts and the Projects table (the test account's own org has `sikstack`, made by `up`; a new account's org starts with no project, so there is no `default`).

```bash drive
"$RUN" signin
playwright-cli -s="$SESSION" goto "$WEB/dashboard"
"$RUN" expect "Usage, last 30 days" "Projects" "sikstack"
playwright-cli -s="$SESSION" find "Projects"
playwright-cli -s="$SESSION" screenshot --filename="$EV/overview.png"
```

**Proof:** URL `/dashboard`; the texts "Usage, last 30 days" and "Projects"; a Projects row `sikstack` (Private, Keys 1 or more). `overview.png` is the picture of the signed-in product.
