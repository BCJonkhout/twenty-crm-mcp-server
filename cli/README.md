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

## Schrijven in het CRM

```sh
cato people create --first-name Anne --last-name Jansen --email a@kantoor.nl --company-id <uuid>
cato people update <id> --job-title "Partner"
cato people delete <id> --no-dry-run --yes
cato companies create --name "Nieuw Kantoor" --domain nieuwkantoor.nl
cato companies update <id> --branche ADVOCATUUR
```

Alleen de velden die je meegeeft worden geschreven — een update met alleen een voornaam laat de
achternaam staan. Bij `people create` met `--company-id` neemt de CLI automatisch de
`accountOwnerId` van dat bedrijf over als eigenaar; zonder dat is de persoon onzichtbaar voor de
Sales Rep die het account beheert. Met `--assignee-id` overrule je dat.

## Wat is er naar deze persoon gestuurd?

```sh
cato people history <persoon-id>
```

Toont de campagnes waar iemand in zit en elke mail die we hem stuurden — datum, fase, onderwerp,
plus opens en clicks per bericht. Een bounce wordt als zodanig gemarkeerd en een uitschrijving
levert een expliciete waarschuwing op, ook als er verder niets te tonen valt.

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

### Volledige dekking

Alle 51 endpoints van de marketing-module zijn via de CLI bereikbaar. Commando's met meerdere
acties nemen die als eerste argument:

```sh
cato marketing access                                    # wat mag deze credential
cato marketing research  status|start|stop|target --campaign <id>
cato marketing candidates list|attach|remove|attach-crm|staged --campaign <id> --ids a,b,c
cato marketing members   list|add|bulk|attach-matching|remove|stop|mark-todo --campaign <id>
cato marketing targets   list|add|add-matching|remove --campaign <id>
cato marketing prompts   get|set --campaign <id> --body '<json>'
cato marketing schedule  get|set --campaign <id> --body '<json>'
cato marketing search-settings get|set --campaign <id> --body '<json>'
cato marketing assets    list|create|update
cato marketing update|archive|restore|delete --campaign <id>
cato marketing regenerate --touchpoint <id>
cato marketing bulk-approve --campaign <id>              # toont eerst hoeveel
cato marketing people | filter-options | crm-picker      # opzoeklijsten
```

### Controleren of een onderzoeksrun deugt

```sh
cato marketing verify --campaign <id>
```

Meet wat eerlijk te meten valt: kan het adres mail ontvangen (MX), citeert het model de
**eigen site** van het kantoor of een leadverzamelaar, hoeveel kantoren leverden iets op, en
zijn er meer kandidaten dan de run mocht produceren. Eindigt met `USABLE`, `REVIEW` of
`DO NOT SEND` (afsluitcode 1).

Belangrijker dan het oordeel is de sectie **COULD NOT BE JUDGED**: controles die niet konden
draaien worden apart benoemd, zodat een groen oordeel nooit voor bewijs wordt aangezien. Dat
is geen theorie — de eerste versie van deze controle meldde `USABLE` terwijl zijn
domeinvergelijking stilletjes niets te vergelijken had.

Wat het **niet** doet: vaststellen of de personen bestaan. Namen toetsen door websites te
crawlen is gemeten en onbetrouwbaar bevonden (jongbloed.tv laadde niet eens). Wat wél is
gemeten op 2026-08-02: van de 95 controleerbare kandidaten stond 87 daadwerkelijk op de
pagina die het model citeerde. Behandel elke kandidaat als voorstel voor de selectiestap.

### Een campagne opzetten

De volledige keten, in werkvolgorde. Elke stap is dry-run tenzij je `--no-dry-run --yes` toevoegt:

```sh
cato marketing create --name "Wave 1 — pilots" --subject "..." --cta-link https://leo.prudai.com
cato marketing targets    --campaign <id> --source-system concurrentie_analyse_legal_ai_2026_07
cato marketing contacts   --campaign <id> --source-system concurrentie_analyse_legal_ai_2026_07
cato marketing generation --campaign <id>            # AI-concepten aanzetten
cato marketing send-test  --campaign <id> --email jij@prudai.com
cato marketing touchpoints --campaign <id> --state pending   # de review-queue
cato marketing approve    --touchpoint <id> --no-dry-run --yes
cato marketing enable     --campaign <id>            # pas hierna pakt de planner hem op
```

`create` valideert zonder credentials, zodat een agent een campagne kan plannen vóór hij een token
heeft. Een nieuwe campagne start **uitgeschakeld, zonder generatie en zonder leden** — aanmaken
verstuurt niets. `targets` en `contacts` weigeren een lege filter: je kunt niet per ongeluk iedereen
selecteren.

Schrijfacties (`approve`, `reject`, `send-now`) vereisen `--no-dry-run --yes` en tonen eerst hoeveel
ontvangers je raakt.

> **Sinds 2026-07-30 accepteert de marketing-module ook API-keys** (en de CLI dus ook) (server-commit `3c570e37`). De
> sleutel wordt door dezelfde rol-check gehaald als een gebruiker: alleen een rol die marketing mag
> beheren komt erdoor. Een API-key krijgt nooit het `sales_rep`-niveau, omdat dat op
> `workspaceMemberId` scopet en een sleutel geen workspace-member heeft.
>
> Een user-sessietoken werkt nog steeds en blijft nodig voor endpoints buiten deze module.
>
> ⚠️ Op dit moment kan alleen de **Admin**-rol aan een API-key worden gekoppeld, en die mag marketing
> beheren. Elke uitgegeven sleutel kan dus campagnes goedkeuren. Wie een sleutel met minder rechten
> wil uitgeven, moet eerst een beperktere rol aanmaken met `canBeAssignedToApiKeys = true`.

## Wat dit bewust NIET doet

- **Geen auto-approve.** Elke marketing-touchpoint vereist in CATO zelf `approvalState='approved'`
  voor hij verstuurd wordt. Die eis omzeilen we niet — bij koude B2B-outreach is menselijke
  goedkeuring een bewuste rem.
- **Geen mail versturen buiten CATO om.** Verzending loopt via de SendGrid-integratie van de
  server, niet via de CLI.
- **Geen schrijfpad in `import`** zonder `--source-system`; mét die vlag alleen herkomstvelden.
- **Geen secrets in de repo.** De CLI leest bij voorkeur uit OpenBao (`kv/prod/prudai-twenty/app`).

## Ratelimits en herhaalpogingen

De CLI deelt zijn HTTP-laag met de MCP-server (`core/src/rest.ts`), dus beide gedragen zich
identiek: 30 s timeout per verzoek, maximaal 4 herhalingen, en bij een `Retry-After`-header wordt
exact zolang gewacht als de server vraagt. Zonder die header geldt exponentiële backoff met jitter
(±0,5–1 s, 1–2 s, 2–4 s, tot maximaal 8 s), zodat parallelle clients niet in hetzelfde ritme
terugkomen.

**Een POST of PATCH wordt alleen herhaald na een 429.** Dan heeft de server het verzoek aantoonbaar
geweigerd en is er niets uitgevoerd. Na een 5xx, een timeout of een verbroken verbinding weet je dat
níet — de rij kan al geschreven zijn — dus stopt de client en zegt hij in de foutmelding waaróm hij
niet opnieuw geprobeerd heeft. Alleen `GET`, `PUT`, `DELETE`, `HEAD` en `OPTIONS` worden bij die
fouten herhaald. Een endpoint dat als POST is vormgegeven maar echt herhaalbaar is, kan zich
aanmelden met `idempotent: true`.

## Nog te doen

**Documentatie op `crm.prudai.com/docs` (feature voor later).** Er is nu geen enkele in-app
documentatie: nginx proxyt alles ongefilterd naar de app, er is geen `/docs`-route in
`twenty-shared/AppPath.ts` en geen docs-pagina in de front-end. De vijf markdown-bestanden in
`prudai-twenty/docs/` worden nergens geserveerd.

Waarom dit de moeite waard is: de marketing-module is eigen bouw en kent inmiddels
~47 endpoints, 13 tabellen, een goedkeurings-workflow en een verzendvenster. Wie daar nieuw
instapt — Geert, Roland, een coding agent van Bas — heeft nu geen andere bron dan de broncode of
deze README. Een `/docs`-route in de app zelf brengt die uitleg naar de plek waar het werk gebeurt.

Denkbare inhoud: de campagne-levenscyclus (concept → goedgekeurd → verstuurd), wie wat mag per rol,
wat het verzendvenster doet, hoe herkomst-tags (`prudaiMarketingSource*`) doorwerken in doelgroepen,
en de CLI-commando's uit deze README.

Aandachtspunt bij het bouwen: zet het achter dezelfde auth als de rest van de app. Een deel van deze
documentatie beschrijft wie er mag verzenden — dat hoort niet publiek te staan.

## Bekende afwijking

`TWENTY_API_KEY` staat in platte tekst in `/root/librechat/.env` en in
`/root/.claude/settings.json`, terwijl de overige secrets uit OpenBao komen. Dat is bestaande
situatie, niet iets wat deze CLI introduceert — maar het hoort opgeruimd te worden.

Sinds 2026-08-13 staat dezelfde sleutel óók in OpenBao op `kv/prod/cato-cli/app` (`CATO_API_KEY`),
zodat de CLI hem zelf kan ophalen met `CATO_BAO_TOKEN` gezet. De plattetekstkopieën hierboven zijn
daarmee niet meer de enige bron, maar ze bestaan nog — pas op dat je bij het roteren van de sleutel
alle drie de plekken meeneemt.

## Ontwikkelen

```sh
bun run typecheck     # tsc over de hele monorepo
bun test cli/tests    # unit tests van de CLI (113 tests)
bun test              # inclusief de MCP-E2E-tests; vereist TWENTY_API_KEY in de omgeving
bun run openapi:generate   # regenereert openapi/cato.yaml uit de live metadata-API
```
