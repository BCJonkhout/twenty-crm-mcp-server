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
cato people search "advocaat" --csv > advocaten.csv   # matcht op naam, e-mail, telefoon én functietitel
cato companies list --json
cato opportunities list
cato notes list
cato tasks list --overdue       # takenbord: status, deadline, eigenaar, gekoppeld record
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

> **`delete` is definitief, voor élk object.** Twenty's REST-delete kent een `soft_delete`-
> parameter die standaard op `false` staat ("If false, objects are permanently deleted" — zie
> `cli/openapi/cato.yaml`, gegenereerd uit de live CRM) en deze CLI stuurt hem niet mee. Gemeten
> op CATO v1.19 (25-08-2026) met een wegwerptaak: de rij was daarna weg uit de database, terwijl
> de 310 via de UI verwijderde rijen er gewoon nog stonden. De prullenbak in de web-UI is dus wel
> een soft delete, deze niet. De dry-run zegt dat nu ook met zoveel woorden — hij beweerde eerder
> het tegenovergestelde.
>
> Openstaand productbesluit: moet `cato people delete` / `cato companies delete` juist wel
> `soft_delete=true` meesturen? Dat verandert gedrag op productiedata, dus dat is hier bewust
> niet eenzijdig gedaan; alleen de tekst is naar de waarheid gebracht.

## Taken

Het takenbord van PrudAI verhuist van Trello naar CATO. `cato tasks` is het schrijfpad dat
`/memo-verwerken`, `/give-me-work`, `/trello-agenda` en `/trello-groom` daarvoor gaan gebruiken —
die skills draaien op het moment van schrijven nog op Trello, dus dit is de kant die klaarstaat,
niet een koppeling die al loopt.

```sh
cato tasks list --status TODO --assignee beau --board PRUDAI
cato tasks list --overdue                       # deadline verstreken en niet DONE
cato tasks list --due-after 2026-09-01 --due-before 2026-09-07
cato tasks list --company-id <uuid>             # alles wat aan dit bedrijf hangt
cato tasks list --label BUG --priority HIGH --source AGENT
cato tasks search "offerte"
cato tasks get <id>                             # alle velden, body als markdown, targets
cato tasks comments <id>                        # de opmerkingen, oudste eerst

cato tasks create --title "Bel terug" --board PRUDAI --company-id <uuid> --due 2026-09-04 \
     --body-file notitie.md --assignee geert --no-dry-run --yes
cato tasks update <id> --status "in progress" --due "2026-09-04T10:00" --no-dry-run --yes
cato tasks claim <id> --assignee codex --no-dry-run --yes    # IN_PROGRESS + eigenaar
cato tasks park <id> --no-dry-run --yes                      # ON_HOLD, due +14 dagen
cato tasks comment <id> --body "🤖 opgepakt in sessie X" --no-dry-run --yes
cato tasks complete <id> --no-dry-run --yes     # kort voor --status DONE (`done` mag ook)
cato tasks delete <id> --no-dry-run --yes
```

| Verb | Wat het doet |
|---|---|
| `tasks list` | Takenlijst met status, deadline, eigenaar, gekoppelde records en URL. Filters: `--status`, `--board`, `--label`, `--priority`, `--source`, `--assignee`/`--assignee-id`, `--due-before`/`--due-after`, `--overdue`, `--company-id`/`--person-id`/`--opportunity-id`, plus `--all` en `--limit`. |
| `tasks get <id>` | Eén taak: alle velden (ook bord, labels, prioriteit, bron, betrokkenen, laatste opmerking), de body als markdown, de targets met naam én id. |
| `tasks search <term>` | Zoekt hoofdletterongevoelig in de titel, met dezelfde filters als `list`. |
| `tasks create` | Nieuwe taak. `--board` is verplicht; `--due` ook, tenzij expliciet `--no-due`; een target (`--company-id`/`--person-id`/`--opportunity-id`) ook, tenzij expliciet `--no-target`. Zonder `--status` landt een taak met `--source AGENT`/`MEMO`/`CHAT` in `INBOX` (agents maken aan, Beau/Geert triëren), anders in `TODO`. |
| `tasks update <id>` | Titel, status, deadline, eigenaar, body, bord, labels, prioriteit, bron, betrokkenen, bronlink, legacy-ref of een custom veld. Koppelingen blijven staan. |
| `tasks claim <id>` | Pakt de taak op: status `IN_PROGRESS` + de `--assignee` die je noemt (verplicht). |
| `tasks park <id>` | Parkeert: status `ON_HOLD`, due op wanneer hij terugkomt (default +14 dagen — de bordregel). |
| `tasks comment <id>` | Zet een opmerking op de taak (`--body`/`--body-file`) én stempelt `lastCommentAt`/`lastCommentPreview` (eerste ~120 tekens) op de kaart. |
| `tasks comments <id>` | Leest de opmerkingen, chronologisch. |
| `tasks complete <id>` | Zet de status op `DONE`. Alias: `tasks done`. |
| `tasks delete <id>` | Verwijdert de taak. |

**Status:** `INBOX`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `ON_HOLD`, `DONE` — hoofdletterongevoelig,
en `in progress` mag ook. Anders dan de stage-enum van opportunities weigert de CLI een onbekende
status níet zelf: hij normaliseert, waarschuwt op stderr, en laat CATO's veld-metadata beslissen.
Een status die morgen in de UI wordt toegevoegd werkt dus meteen, en een typefout levert nog
steeds een duidelijke 400 van de server op.

**Bordvelden** (gemeten aan de live metadata, 31-08-2026): `--board` (`PRUDAI`/`PRODUCT`),
`--label` (`DISCUSS_TOGETHER`/`BUG`/`IMPROVEMENT`/`FEATURE_REQUEST`/`RESEARCH`, herhaalbaar of
komma-gescheiden; een write vervangt de hele set), `--priority` (`HIGH`/`MEDIUM`/`LOW`),
`--source` (`MEMO`/`CHAT`/`AGENT`/`MANUAL`), `--betrokkenen`
(`BEAU`/`GEERT`/`BAS`/`ROLAND`/`CODEX`), `--source-link` (absolute URL naar het bronverslag) en
`--legacy-ref` (Trello-herkomst, alleen voor de migratie). Déze waarden worden wél door de CLI
afgedwongen: het zijn stabiele bordconfiguratie, en een typefout die stil niets matcht zou het
bord verkeerd rapporteren.

**Opmerkingen** zijn `comment`-records (object "Opmerking") die via een relatie aan de taak
hangen; auteur en tijd komen gratis uit `createdBy`/`createdAt`. `tasks comment` schrijft er één
en werkt daarna de kaartvelden bij; mislukt dat tweede deel, dan blijft de opmerking staan en
faalt het commando luid — de opmerking is de inhoud, de preview is afgeleid.

**Deadlines** worden gelezen en getoond in Europe/Amsterdam, niet in de tijdzone van de host.
`--due 2026-09-04` is middernacht hier (de UI toont de 4e, en de taak is verlopen vanaf het begin
van die dag); `--due 2026-09-04T10:00` is 10:00 hier, DST-bewust. Een ISO-tijdstempel mét zone
wordt letterlijk genomen.

Belangrijk: `--due-before` en `--due-after` verankeren een kale dag in diezelfde zone, dus een
zoekvenster bevat precies de taken die je er met `--due` in geschreven hebt. `--due-before
2026-09-04` is inclusief die hele dag (de grens ligt op het begin van de 5e, hier). Toen die twee
kanten niet gelijk liepen — schrijven in Amsterdam, filteren in UTC — sloeg `--due-after <dag>`
stilzwijgend elke kaart van die dag over; dat is het soort fout dat een compleet ogend antwoord
geeft, dus er staat nu een test op die de twee kanten tegen elkaar houdt in plaats van tegen een
letterlijke grenswaarde.

**Koppelen** gebeurt via `taskTargets`, net als bij notes. Mislukt het koppelen, dan wordt de taak
weer verwijderd — een taak die aan niets hangt is een kaart die niemand terugvindt. Een taak
zónder target kan alleen met een expliciete `--no-target` (intern werk): elke taak die een klant
raakt hangt aan die klant, want de tijdlijnregel op de klantpagina ontstaat op het koppelmoment.

**Eigenaar:** `--assignee` zoekt een workspace member op voornaam, achternaam, volledige naam of
e-mail en weigert een dubbelzinnige treffer met de kandidaten erbij. `--assignee-id <uuid>` slaat
die zoektocht over. `--assignee me` bestaat niet: een API-sleutel ís geen workspace member.

**`--field key=value`** is het doorgeefluik voor custom velden die nog geen eigen vlag hebben;
`--field key:=<json>` schrijft een getal, boolean of lijst. Velden die wél een vlag hebben
(status, due, board, labels, …) worden geweigerd, zodat niemand de normalisatie en validatie
omzeilt. `lastCommentAt`/`lastCommentPreview` blijven bewust open — de Trello-migratie vult ze
met terugwerkende kracht via `--field`. Bestaat het veld niet in CATO, dan zie je de 400 van de
server.

> **`tasks delete` is definitief** — net als elke andere `delete` in deze CLI; zie het kader
> onder "Schrijven in het CRM".

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

## Wijziging in datumvlaggen (25-08-2026)

Alle datumvlaggen (`--due-before`, `--due-after`, `--created-since`, `--updated-since`,
`--close-after`, `--close-before`) accepteren nog uitsluitend `YYYY-MM-DD` of een ISO-8601-
tijdstempel. Vormen die JavaScript's `new Date()` eerder stilzwijgend slikte — `04-09-2026`,
`2026/07/01`, `July 1, 2026`, `20260701` — leveren nu een foutmelding op in plaats van een
antwoord over de verkeerde maand: `04-09-2026` werd gelezen als 9 april en `2026-02-30` als
2 maart. Wie zo'n vorm gebruikte, ziet een expliciete melding met het juiste formaat erbij.

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
bun test cli/tests    # unit tests van de CLI
bun test              # inclusief de MCP-E2E-tests; vereist TWENTY_API_KEY in de omgeving
bun run openapi:generate   # regenereert openapi/cato.yaml uit de live metadata-API
```
