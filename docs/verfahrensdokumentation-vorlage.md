# Verfahrensdokumentation - Vorlage für Zollify-Nutzer

Die GoBD (Rz. 151 ff.) verlangen für jedes DV-System, mit dem steuerlich relevante Daten erfasst werden, eine
Verfahrensdokumentation, aus der ein sachverständiger Dritter in angemessener Zeit nachvollziehen kann, wie die
Aufzeichnungen entstehen, verarbeitet, aufbewahrt und ausgewertet werden. Diese Vorlage füllt die Teile vor, die Zollify
betreffen. Alles in **[eckigen Klammern]** ersetzen Sie durch Ihre Angaben; Abschnitte, die auf Sie nicht zutreffen,
streichen Sie. Lassen Sie das Ergebnis von Ihrer Steuerberaterin oder Ihrem Steuerberater prüfen.

Stand der Vorlage: Oktober 2026, Zollify ab Version [Version aus Einstellungen → Dieses Gerät].

---

## 1. Allgemeine Beschreibung

### 1.1 Unternehmen

- Firma / Inhaber: **[Name]**
- Anschrift: **[Straße, PLZ Ort, Land]**
- Steuernummer / USt-IdNr.: **[...]**
- Tätigkeit: Verkauf von **[Kunstdrucken, Stickern, Büchern, ...]** auf Messen und Conventions (Artist Alley)
  **[und im Ladengeschäft / in Kommission]** gegen Barzahlung und Kartenzahlung.
- Betriebsstätte, der die Kassen zugeordnet sind: **[Anschrift]**. Die Kassen werden mobil an wechselnden
  Veranstaltungsorten eingesetzt (siehe 2.2).

### 1.2 Zweck und Umfang des Verfahrens

Zollify ist das Kassensystem: Es erfasst jeden Verkauf im Moment des Bezahlens, nummeriert die Belege lückenlos pro
Kasse, lässt sie in Deutschland von einer zertifizierten technischen Sicherheitseinrichtung (TSE) signieren, erstellt
den Kassenabschluss je Kasse und Tag und stellt die Daten im DSFinV-K-Format für die Finanzverwaltung bereit. Es führt
daneben den Warenbestand und erstellt Kassenbons (Papier und/oder digital).

Nicht Teil von Zollify: die Finanzbuchhaltung, die Umsatzsteuer-Voranmeldung und die Belegablage der Eingangsrechnungen.
Diese erfolgen in **[Buchhaltungssoftware / beim Steuerberater]**; die Kassenabschlüsse aus Zollify werden dort als
**[monatliche Kassenberichte / Export ...]** übernommen.

### 1.3 Verantwortliche

| Rolle | Person | Aufgabe |
|---|---|---|
| Inhaber / Verantwortlicher | **[Name]** | Einrichtung, Freigabe von Änderungen, Aufbewahrung, Auskunft bei Prüfungen |
| Kassenbediener | **[Namen oder "Inhaber und angemeldete Mitarbeiter"]** | Verkäufe erfassen, Kassensturz, Tagesabschluss |
| Steuerberatung | **[Kanzlei]** | Buchführung, Prüfung dieser Dokumentation |
| Betreiber des Zollify-Servers | **[zollify.app, betrieben von ... / eigener Server bei ...]** | Hosting, Datensicherung, TSE-Anbindung |

## 2. Anwenderdokumentation

### 2.1 Geräte (Kassen)

Jedes Gerät, das Verkäufe erfasst, ist eine Kasse mit eigener Kassen-Seriennummer (Zollify: „Till serial number",
Einstellungen → Dieses Gerät → TSE). Die Liste der Kassen mit Erst- und Letztbeleg und zugeordneter TSE erzeugt Zollify
unter Einstellungen → Tax export (Germany) → Till register. Stand bei Erstellung dieser Dokumentation:

| Kassen-Seriennummer | Gerät | In Betrieb seit | Außer Betrieb seit | TSE |
|---|---|---|---|---|
| **[ZOLLIFY-XXXXXXXX]** | **[myPOS Carbon / Android-Telefon / Browser]** | **[Datum]** | - | **[fiskaly Cloud-TSE, Seriennummer ...]** |

Die Meldung an das Finanzamt nach § 146a Abs. 4 AO erfolgte am **[Datum]** über Mein ELSTER; Kopie liegt unter
**[Ablageort]**.

### 2.2 Einsatz an wechselnden Orten

Die Kassen werden an Veranstaltungen (Messen, Conventions) eingesetzt. Jede Veranstaltung ist in Zollify als „Event"
mit Name, Ort, Land, Zeitraum und Währung angelegt. Jeder Verkauf ist einer Veranstaltung zugeordnet; der
Kassenabschluss (Z) umfasst die Belege einer Kasse an einem Tag an einer Veranstaltung in einer Währung. Im DSFinV-K-Export
steht die Veranstaltung als Ort (location.csv) beim jeweiligen Abschluss.

### 2.3 Ablauf eines Verkaufs

1. Artikel aus dem Katalog in den Warenkorb legen (Antippen, Barcode-Scan oder Suche). Beim ersten Artikel startet die
   Kasse die TSE-Transaktion.
2. Rabatte: **[Regeln, z. B. „3 Drucke für 25 €"; Einzelrabatte nur durch Inhaber]**. Jeder Rabatt wird mit Name und
   Betrag am Verkauf gespeichert und auf dem Beleg ausgewiesen.
3. Zahlart wählen: bar oder Karte (**[Terminal: myPOS / SumUp / ...]**). Bei Kartenzahlung bestätigt das Terminal;
   geteilte Zahlungen (teils bar, teils Karte) sind möglich und werden je Zahlweg gespeichert.
4. Beim Bezahlen wird der Verkauf gespeichert: fortlaufende Belegnummer der Kasse, Zeitstempel, Positionen mit
   Umsatzsteuersatz, Zahlwege, TSE-Signatur (Transaktionsnummer, Signaturzähler, Start, Ende, Signatur).
5. Der Kunde erhält den Beleg: QR-Code zum digitalen Beleg auf dem Bildschirm, auf Wunsch Papierbon über den
   **[eingebauten / Bluetooth-]**Drucker. In Deutschland wird der Beleg bei jedem Verkauf angeboten (Belegausgabepflicht).

### 2.4 Storno

Ein Verkauf kann nur als Ganzes storniert werden („Revert"). Der ursprüngliche Beleg bleibt unverändert gespeichert.
Der Storno erhält eine eigene fortlaufende Belegnummer und eine eigene TSE-Signatur mit negativen Beträgen und verweist
auf den stornierten Beleg. Teilstornos erfolgen als Storno des ganzen Verkaufs und Neuerfassung.
**[Wer darf stornieren; wie wird der Grund festgehalten, z. B. Notiz im Kassenbuch.]**

### 2.5 Bargeldbewegungen und Kassensturz

- Anfangsbestand (Wechselgeld), Einlagen, Entnahmen und Bankeinzahlungen werden unter Kassensturz → „Cash in and out"
  erfasst. Jede Bewegung ist ein eigener Beleg (Belegnummer, TSE-Signatur) und erscheint im Abschluss und im Export als
  Anfangsbestand, Privateinlage, Privatentnahme bzw. Geldtransit.
- Kassensturz: Am Ende des Tages wird der Kassenbestand nach Stückelung gezählt (Kassensturz-Bildschirm). Zollify zeigt
  Soll (Anfangsbestand + Bareinnahmen + Einlagen − Entnahmen), Ist und Differenz. Differenzen werden **[wie
  dokumentiert / wer entscheidet]**.
- Tagesabschluss: „Close the day" auf jeder Kasse. Die Kasse schließt außerdem selbst ab, wenn Tag, Veranstaltung oder
  Währung wechseln, und beim ersten Start an einem neuen Tag.

### 2.6 Nutzer und Rechte

| Rolle in Zollify | Darf |
|---|---|
| Owner | alles, einschließlich Einstellungen, TSE, Export, Löschen des Kontos |
| Admin | Katalog, Veranstaltungen, Einstellungen, Export |
| Member (Mitarbeiter) | Verkäufe, Stornos, Bestandsmeldungen, Kassensturz der eigenen Verkäufe; **[Umsatzsummen: sichtbar / nicht sichtbar]** |

Mitarbeiter melden sich mit eigenem Konto oder per Mitarbeiter-Badge an einer gemeinsamen Kasse an; jeder Verkauf
speichert, wer ihn erfasst hat. Aktuelle Nutzer: **[Liste oder Verweis auf Einstellungen → Team]**.

### 2.7 Stammdaten

Artikel (Name, Varianten, Preis, Umsatzsteuersatz, SKU/Barcode) werden im Katalog gepflegt; Änderungen gelten ab
sofort für neue Verkäufe, gespeicherte Verkäufe behalten Bezeichnung und Preis zum Verkaufszeitpunkt. Umsatzsteuersätze
werden je Land und Artikel bestimmt (Einstellungen → VAT); **[Kleinunternehmerregelung: ja/nein, EU-KU-Regelung mit
EX-Nummer: ...]**.

## 3. Technische Systemdokumentation

### 3.1 Aufbau

- **Kassen-App**: Zollify als Web-App im Browser oder als Android-App (auch auf dem Zahlungsterminal myPOS Carbon).
  Alle Daten werden zuerst lokal auf dem Gerät gespeichert (IndexedDB) und laufend an den Server übertragen; die Kasse
  funktioniert auch ohne Verbindung weiter, ausgenommen Cloud-TSE-Signaturen (siehe 3.3).
- **Server**: **[zollify.app / eigene Installation]**, Node.js-Dienst mit SQLite-Datenbank, Standort **[Rechenzentrum,
  Land]**. Der Server hält das Änderungsprotokoll aller Geräte eines Kontos, stellt die digitalen Belege bereit und
  erstellt den DSFinV-K-Export.
- **TSE**: **[fiskaly Cloud-TSE (fiskaly GmbH, Wien), angebunden über den Zollify-Server / Swissbit-TSE als
  USB-/microSD-Stick am Gerät]**. Zertifizierungs-ID: **[BSI-K-TR-...]**.
- **Zahlungsterminals**: **[Hersteller, Modell]**; Kartenumsätze werden vom Terminalanbieter abgerechnet, Zollify
  speichert je Verkauf Zahlweg, Betrag und, wo verfügbar, die Transaktionsreferenz.

### 3.2 Datenhaltung und Unveränderbarkeit

Jede Änderung (Verkauf, Storno, Artikel, Bestand, Abschluss, Bargeldbewegung) ist ein Eintrag im Änderungsprotokoll
(„op log") mit eindeutiger ID, Gerät und Zeitstempel. Einträge werden nur angefügt, nie geändert oder gelöscht; der
Server ordnet sie fortlaufend und verteilt sie an alle Geräte des Kontos. Ein Verkauf kann nicht editiert werden - ein
Storno ist ein neuer Eintrag, der auf ihn verweist. Belegnummern werden je Kasse lückenlos vergeben, Stornos und
Bargeldbewegungen zählen mit. Der Kassenabschluss wird einmal erstellt und nie verändert.

### 3.3 TSE-Anbindung und Ausfall

Beim ersten Artikel eines Verkaufs wird eine TSE-Transaktion gestartet, beim Speichern mit den Belegdaten
(Vorgangstyp „Kassenbeleg-V1": Bruttobeträge je Steuersatz, Zahlwege) abgeschlossen. Geräte ohne eigene TSE signieren
über ein „Haupt-TSE-Gerät" des Kontos über die Live-Verbindung. Fällt die TSE aus oder ist sie nicht erreichbar,
speichert Zollify den Verkauf mit dem Vermerk „TSE ausgefallen" samt Grund und Zeitpunkt; der Beleg trägt den Hinweis,
der Ausfall wird mit Beginn, Ende und Grund protokolliert (Einstellungen → Dieses Gerät → TSE-Ausfälle) und erscheint im
DSFinV-K-Export (TSE_TA_FEHLER). **[Vorgehen bei längerem Ausfall: Meldung an ..., Nachweis ...]**

### 3.4 Schnittstellen und Export

- **DSFinV-K 2.4**: Einstellungen → Tax export (Germany); ZIP mit allen 20 Dateien, index.xml und DTD; Zeitraum
  wählbar; vorab Prüfung auf fehlende Abschlüsse oder nicht synchronisierte Belege.
- **TSE-Export (TAR)**: **[fiskaly: über das fiskaly-Dashboard / Swissbit: über die Zollify-Gerätefunktion ...]**.
- Digitale Belege: öffentliche Seite je Beleg (Link im QR-Code), **[400]** Tage abrufbar.
- **[Weitere: Odoo, Shopify, e-conomic, Peppol ...]**

### 3.5 Datensicherung

Der Server sichert die Datenbank **[täglich, Aufbewahrung ... Tage, Ort]**. Zusätzlich lokale Sicherung über
Einstellungen → Backup & restore (JSON-Datei) **[Rhythmus, Ablageort]**. Jedes Gerät hält eine vollständige Kopie der
Kontodaten.

### 3.6 Software-Versionen und Änderungen

Zollify wird als Web-App ausgeliefert; die App auf Android aktualisiert ihren Inhalt über den Server (Neustart nach
Hinweis). Die laufende Version steht unter Einstellungen → Dieses Gerät und wird in jedem Kassenabschluss gespeichert
(cashregister.csv, KASSE_SW_VERSION). Änderungen der Software sind im Quellcode-Verlauf **[Repository]** nachvollziehbar.
Änderungen an Einstellungen (Steuersätze, TSE, Nutzer) nimmt **[Rolle]** vor und hält sie **[wo]** fest.

## 4. Betriebsdokumentation

### 4.1 Tagesablauf

| Zeitpunkt | Schritt | Wer |
|---|---|---|
| Vor Verkaufsbeginn | Gerät geladen, Verbindung geprüft, TSE-Status „Ready" (Einstellungen → Dieses Gerät → Check TSE), Veranstaltung aktiv, Anfangsbestand erfasst | **[...]** |
| Während des Tages | Verkäufe erfassen, Beleg anbieten, Entnahmen/Einlagen sofort erfassen | **[...]** |
| Verkaufsende | Kassensturz, Differenz klären, „Close the day", Gerät synchronisieren lassen | **[...]** |
| Monatlich | DSFinV-K-Prüfung („Check") auf fehlende Abschlüsse; Kassenberichte an die Buchhaltung | **[...]** |

### 4.2 Aufbewahrung

Verkäufe, Stornos, Abschlüsse und Bargeldbewegungen werden auf dem Server und auf den Geräten unverändert aufbewahrt;
sie werden nicht nach Fristen gelöscht. Aufbewahrungsfrist: 10 Jahre (§ 147 AO) **[bzw. 8 Jahre für Buchungsbelege ab
2025, Prüfung durch Steuerberater]**. Vor Kündigung des Kontos oder Wechsel des Systems wird ein vollständiger
DSFinV-K-Export über den gesamten Zeitraum und ein Backup erstellt und **[wo]** abgelegt.

### 4.3 Kassennachschau

Bei einer Kassennachschau (§ 146b AO) werden vorgelegt: diese Dokumentation, die Meldung nach § 146a Abs. 4 AO, der
DSFinV-K-Export des verlangten Zeitraums (sofort aus Zollify erstellbar), der TSE-Export, die Kassenabschlüsse und das
Kassenbuch der Buchhaltung. Zugang zum Konto hat **[Name]**.

### 4.4 Internes Kontrollsystem

- Trennung: Mitarbeiter erfassen Verkäufe, nur Inhaber/Admin ändern Preise, Steuersätze und TSE-Einstellungen.
- Täglicher Kassensturz mit Soll-Ist-Vergleich; Differenzen über **[Betrag]** werden begründet.
- Monatliche Prüfung des Exports auf Lücken; Vergleich der Kartenumsätze mit den Terminal-Abrechnungen.
- Jahresweise Prüfung dieser Dokumentation auf Aktualität: zuletzt am **[Datum]** durch **[Name]**.

---

## Änderungshistorie dieser Dokumentation

| Datum | Änderung | Wer |
|---|---|---|
| **[Datum]** | Erstfassung | **[Name]** |
