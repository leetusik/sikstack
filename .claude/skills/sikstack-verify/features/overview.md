# Overview (`/dashboard`)

**Reach it:** sign in; the app lands on `/dashboard`. The header's org link and the "Overview" tab lead back to it.

**Drive it:** open it signed in and read the org heading, the usage and document counts and the Projects table (the test account's own org has `sikstack`, made by `up`; a new account's org starts with no project, so there is no `default`). The org's name and Public URL are Org settings' panels (`/settings`), no longer here; the org's API keys stay.

```bash drive
"$RUN" signin
playwright-cli -s="$SESSION" goto "$WEB/dashboard"
"$RUN" expect "Usage, last 30 days" "Projects" "sikstack" "Org API keys"
heads=$(playwright-cli -s="$SESSION" --raw eval '() => [...document.querySelectorAll("h2")].map(h => h.innerText.trim()).join(",")' | tr -d '"')
echo "headings: $heads"
case ",$heads," in *,"Org name",*|*,"Public URL",*) echo "FAIL org home still draws Org name or Public URL"; exit 1 ;; esac
case ",$heads," in *,"Org API keys",*) echo "ok   org home keeps the org keys" ;; *) echo "FAIL no Org API keys"; exit 1 ;; esac
playwright-cli -s="$SESSION" find "Projects"
playwright-cli -s="$SESSION" screenshot --filename="$EV/overview.png" --full-page
```

**Proof:** URL `/dashboard`; the texts "Usage, last 30 days" and "Projects"; a Projects row `sikstack` (Private, Keys 1 or more); the headings hold "Org API keys" and neither "Org name" nor "Public URL". `overview.png` (full page) is the picture of the signed-in product, the org keys panel at its foot.
