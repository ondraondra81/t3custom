# Ruční přenos mezi T3 Code a T3 Custom

Nástroj je určený pro střídání obou aplikací na jednom Macu. Pracuj vždy pouze
v jedné aplikaci. Před přechodem ji ukonči a předej aktuální data druhé aplikaci.
Přenosy se nespouštějí automaticky.

## Příprava

Rozbal celý balíček do Downloads a ponech `sync-profiles.sh` a `sync-profiles.mjs`
vedle sebe. V Terminálu přejdi do rozbalené složky. Nástroj využívá běhové prostředí
nainstalovaného T3 Custom; samostatný Node ani Python nepotřebuješ.

Obě aplikace musejí být v `/Applications` nebo `~/Applications` a každou je potřeba
alespoň jednou otevřít. Podporované jsou jejich výchozí profily `~/.t3/userdata`
a `~/.t3custom/userdata`. Vlastní `T3CODE_HOME`, symlinkované kořenové složky
a symlinky uvnitř přenášených dat nástroj odmítne. Lokální odkazy providerů
(například Codex shadow home) zachová jako odkazy; jejich cíle nekopíruje.

Před každým přenosem dokonči nebo zastav běžící agenty, pozastav plánované úlohy
a **obě aplikace ukonči přes Cmd+Q**. Samotné zavření okna nestačí. Nástroj odmítne
otevřenou databázi i nedokončené operace, které by mohly po přenosu pokračovat.

## První přenos do Customu

Při prvním přenosu zvolíš, který profil je zdrojem aktuální práce. Následující
příkazy vezmou data z původního T3. Dosavadní lokální historii Customu nahradí;
její úplná záloha zůstane uložená. Historie se neslučují.

Nejprve ověř stav:

```bash
bash sync-profiles.sh to-custom --check --initialize
```

Pokud kontroly projdou, proveď přenos:

```bash
bash sync-profiles.sh to-custom --apply --initialize
```

Otevři T3 Custom a ověř svá vlákna a přílohy. `--initialize` patří pouze k prvnímu
přenosu. Pokud je aktuální práce naopak v Customu, použij jako první směr
`to-official --check --initialize` a potom `to-official --apply --initialize`.

## Návrat do původního T3 a další střídání

Po práci v Customu ukonči obě aplikace a spusť:

```bash
bash sync-profiles.sh to-official --check
bash sync-profiles.sh to-official --apply
```

Potom otevři původní T3. Až budeš chtít opět do Customu:

```bash
bash sync-profiles.sh to-custom --check
bash sync-profiles.sh to-custom --apply
```

Před každým předáním se znovu kontroluje kompatibilita a změny cíle. Pokud nástroj
ohlásí změněný cíl, **neobcházej to smazáním záznamu synchronizace**. Zkontroluj
zvolený směr. Pokud vznikla práce v obou profilech, ponech oba profily a jejich
zálohy; je potřeba samostatné sloučení. I změna společného nastavení nebo migrace
databáze může vyžadovat nové posouzení.

## Co se přenáší a co zůstává vlastní aplikaci

Přenášejí se databáze včetně lokálních projektů, vláken, historie, vazeb na relace
providerů, plánovaných úloh v pozastaveném stavu a checkpointů; také přílohy,
browser artifacts, témata, serverová nastavení, uložené preference a klávesové
zkratky v `userdata`. S nastavením se přenášejí jeho uložené klíče providerů,
provider environment, source control, usage limits a device hosts.

Skupiny a jejich vazby zůstávají v Customu a přežijí opakované přenosy. Koordinační
vlákna jsou součástí přenášené historie; původní T3 je neumí zobrazit jako skupiny.
Párování, identita serveru, přístupové relace, propojení prostředí a ostatní lokální
data zůstávají vlastní každé aplikaci. MF1 připoj v každé aplikaci jednou; jeho
historie žije na MF1 a tímto nástrojem se nekopíruje.

**Chromium profil se nepřenáší.** Koncepty zpráv a preference uložené pouze v něm
zůstávají zachované ve své aplikaci. Před přechodem důležitý koncept odešli nebo
zkopíruj. Přihlášení providerů používající vlastní aplikaci či Klíčenku může
vyžadovat nové ověření.

Projektové složky a worktrees zůstávají na svých původních cestách. **Nemaž
`~/.t3` ani `~/.t3custom`**, i když právě pracuješ ve druhé aplikaci. Přenos profilů
nevrací změny souborů v repozitářích.

## Kompatibilita verzí

První verze nástroje rozumí databázovým migracím 79 a 80. Ověřuje také možnosti
obou nainstalovaných aplikací. Obě musejí podporovat stejnou nejvyšší migraci,
aby byl možný přenos zpět i po příštím spuštění aplikace.

Původní `0.1.8-nightly.20261104.4165` a Custom `0.1.7-preview.20261105.6` podporují
migraci 79. Novější Custom založený na nightly `20261106.4262` podporuje migraci 80:
pro střídání s ním nejprve aktualizuj i původní T3 na odpovídající nightly.
Neznámý formát nebo neprůkazná kontrola přenos zastaví. Novější binárka sama o sobě
neznamená možnost vrátit databázi do staršího formátu.

## Zálohy a obnova

Každý přenos vypíše konkrétní zálohu v `~/.t3-profile-sync/backups/`. Obsahuje oba
profily před přenosem a původní cílovou složku. Zálohy obsahují soukromá data
a přihlašovací údaje; nesdílej je. Nástroj je automaticky nemaže.

Při častém střídání zálohy zabírají místo. Po ověření aktuální historie a při
ukončených aplikacích i nástroji můžeš smazat starší složky `transfer-*` v
`~/.t3-profile-sync/backups/`, jejichž starou historii už nepotřebuješ. **Ponech
poslední zálohu**, kterou vypsal úspěšný přenos a na kterou odkazuje `backup` v
`~/.t3-profile-sync/state.json`. Existuje-li `transaction.json`, nejprve dokonči
`--recover` a žádné zálohy nemaž. Záznamy `state.json` ani `transaction.json`
ručně nemaž.

Poslední přenos lze vrátit, pokud od něj v cíli nevznikly další změny. Ukonči obě
aplikace a použij cestu vypsanou přenosem:

```bash
bash sync-profiles.sh --restore "/cesta/vypsaná/přenosem"
```

Při běžné chybě během výměny složek nástroj obnoví původní cílový profil.
Pokud byl proces násilně ukončen nebo vypadlo napájení, **neotvírej aplikace**
a spusť:

```bash
bash sync-profiles.sh --recover
```

Obnova odmítne přepsat práci, která v cíli vznikla po přenosu. Pokud nemůže stav
bezpečně rozpoznat, ponechá zálohy i záznam přenosu pro ruční řešení.

Přenos uchovává vazby na relace providerů. Pokračování skutečného agenta a chování
Klíčenky je potřeba při prvním použití ověřit na tvém Macu. Testovací sada je
určená pro Linux i macOS a kontroluje přenos tam a zpět, skutečné schéma databáze, WAL, konflikty, zachování
lokálních přístupů a obnovu po chybě i náhlém ukončení procesu.
