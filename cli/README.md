# `cato` — CLI voor PrudAI's Twenty CRM (CATO)

Eén command line interface op `crm.prudai.com`, bovenop dezelfde client-kern (`core/`) die ook de
MCP-server (`mcp/`) gebruikt. Bedoeld voor twee soorten gebruikers: mensen die snel iets willen
opzoeken of exporteren, en coding agents die CATO als databron nodig hebben.

## Ontwerpuitgangspunt: lezen tenzij expliciet anders

Elk commando dat productie verandert staat achter **twee** vlaggen: `--no-dry-run --yes`. Alleen
`--yes` is niet genoeg, alleen `--no-dry-run` ook niet. Zonder beide krijg je een dry-run die laat
zien wát er zou gebeuren en hoeveel records het raakt. `cato import` heeft überhaupt geen
schrijfpad — die toont alleen wat een import zou doen.

Dit is een bewuste rem, geen tijdelijke beperking. Bij marketing raakt één verkeerd commando
duizenden echte ontvangers.

## Installatie

```sh
cd /root/twenty-crm-mcp-server
bun install
bun run cato --help          # of: bun run cli/src/index.ts --help
```

## Authenticatie

```sh
cato auth roles              # welke rollen bestaan er, en welke mag aan een API-key hangen
cato auth create --name "bas-readonly" --role-id <uuid>          # dry-run: laat zien wat het zou doen
cato auth create --name "bas-readonly" --role-id <uuid> --no-dry-run --yes   # maakt hem echt aan
cato auth set --stdin        # sleutel opslaan zonder dat hij in je shell-history komt
cato auth status             # welk profiel is actief en wat mag die sleutel
```

De sleutel wordt opgeslagen in `~/.config/cato/credentials.json` met `chmod 600`.
Volgorde van herkomst: `--profile` > `$CATO_API_KEY` > profielbestand.

> **Een API-key in CATO is niet tot alleen-lezen te beperken.**
> Er bestaat op dit moment geen rol die (a) aan een API-key gekoppeld mag worden én (b) alleen
> leesrechten heeft. `cato auth roles` zegt dit ook expliciet als het zo is. Wie een sleutel krijgt,
> krijgt dus schrijfrechten op productiedata. Weeg dat af voor je er één uitgeeft.

## Lezen

```sh
cato people list --limit 50 --json
cato people search "advocaat" --csv > advocaten.csv
cato companies list --json
cato opportunities list
cato notes list
cato segments build --json      # doelgroepselectie uit filters, als JSON of CSV
```

## Marketing

CATO is geen standaard Twenty maar `prudai/twenty:v1.19.0-marketing`, met een eigen
marketing-module (13 tabellen, ~47 endpoints). Die is hier ontsloten:

```sh
cato marketing campaigns              # incl. sendBatchMode en generationEnabled
cato marketing touchpoints --state pending    # de review-queue
cato marketing dispatches
cato marketing events                 # opens, clicks, bounces, unsubscribes
cato marketing schedule               # de weekly windows
```

Schrijfacties (`approve`, `reject`, `send-now`) bestaan, maar vereisen `--no-dry-run --yes` en tonen
eerst hoeveel ontvangers je raakt.

## Wat dit bewust NIET doet

- **Geen auto-approve.** Elke marketing-touchpoint vereist in CATO zelf `approvalState='approved'`
  voor hij verstuurd wordt. Die eis omzeilen we niet — bij koude B2B-outreach is menselijke
  goedkeuring een bewuste rem.
- **Geen mail versturen buiten CATO om.** Verzending loopt via de SendGrid-integratie van de
  server, niet via de CLI.
- **Geen schrijfpad in `import`.** Alleen tonen wat er zou gebeuren.
- **Geen secrets in de repo.** De CLI leest bij voorkeur uit OpenBao (`kv/prod/prudai-twenty/app`).

## Bekende afwijking

`TWENTY_API_KEY` staat op dit moment in platte tekst in `/root/librechat/.env` en in
`/root/.claude/settings.json`, terwijl de overige secrets uit OpenBao komen. Dat is bestaande
situatie, niet iets wat deze CLI introduceert — maar het hoort opgeruimd te worden.

## Ontwikkelen

```sh
bun run typecheck     # tsc over de hele monorepo
bun test cli/tests    # unit tests van de CLI (113 tests)
bun test              # inclusief de MCP-E2E-tests; vereist TWENTY_API_KEY in de omgeving
bun run openapi:generate   # regenereert openapi/cato.yaml uit de live metadata-API
```
