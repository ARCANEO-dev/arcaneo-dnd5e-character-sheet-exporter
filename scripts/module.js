const MODULE_ID = "arcaneo-dnd5e-sheet-exporter";
const CONTROL_ACTION = `${MODULE_ID}-export-html`;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  tryAddExportControl(app, controls);
});

Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
  tryAddExportControl(app, controls);
});

function tryAddExportControl(app, controls) {
  const actor = app?.actor ?? app?.document;
  if (!actor) return;
  if (!(app instanceof foundry.applications.sheets.ActorSheetV2)) return;
  if (actor.type !== "character") return;
  if (!(game.user.isGM || actor.isOwner)) return;
  if (controls.some(c => c.action === CONTROL_ACTION)) return;

  controls.unshift({
    action: CONTROL_ACTION,
    label: "ARCANEO Export Character Sheet (HTML)",
    icon: "fa-solid fa-file-arrow-down",
    visible: true,
    onClick: async () => exportActorAsHtml(actor)
  });
}

async function exportActorAsHtml(actor) {
  try {
    ui.notifications.info(`Exporting ${actor.name} to HTML...`);

    const portrait = await getEmbeddedImage(actor.img);
    const data = await buildActorExportData(actor, portrait);
    const html = buildExportHtml(data);
    const safeName = slugify(actor.name || "character");

    foundry.utils.saveDataToFile(
      html,
      "text/html;charset=utf-8",
      `${safeName}-arcaneo-character-sheet.html`
    );

    ui.notifications.info(`HTML sheet downloaded: ${actor.name}`);
  } catch (error) {
    console.error(`${MODULE_ID} | Export failed`, error);
    ui.notifications.error(`Sheet export failed: ${error.message}`);
  }
}

function getActorItems(actor) {
  if (!actor?.items) return [];
  if (Array.isArray(actor.items)) return actor.items;
  if (Array.isArray(actor.items.contents)) return actor.items.contents;
  return Array.from(actor.items);
}

function getActorEffects(actor) {
  if (!actor?.effects) return [];
  if (Array.isArray(actor.effects)) return actor.effects;
  if (Array.isArray(actor.effects.contents)) return actor.effects.contents;
  return Array.from(actor.effects);
}

function getEmbeddedEffects(document) {
  if (!document?.effects) return [];
  if (Array.isArray(document.effects)) return document.effects;
  if (Array.isArray(document.effects.contents)) return document.effects.contents;
  return Array.from(document.effects);
}

async function buildActorExportData(actor, portrait) {
  const system = actor.system ?? {};
  const details = system.details ?? {};
  const attributes = system.attributes ?? {};
  const abilities = system.abilities ?? {};
  const traits = system.traits ?? {};
  const currency = system.currency ?? {};
  const resources = system.resources ?? {};
  const skills = system.skills ?? {};
  const items = getActorItems(actor);
  const actorEffects = getActorEffects(actor);

  const inventoryTypes = new Set(["weapon", "equipment", "consumable", "loot", "container", "backpack"]);
  const featureTypes = new Set(["feat"]);

  const inventory = await Promise.all(items
    .filter(i => inventoryTypes.has(i.type))
    .sort(sortDocuments)
    .map(async item => ({
      name: item.name,
      img: await getEmbeddedImage(item.img),
      type: item.type,
      quantity: item.system?.quantity ?? 1,
      equipped: Boolean(item.system?.equipped),
      attunement: normalizeAttunement(item.system?.attunement),
      rarity: item.system?.rarity || "—",
      weight: item.system?.weight ?? "—",
      price: formatPrice(item.system?.price),
      activation: item.system?.activation?.type || "",
      uses: formatUses(item.system?.uses),
      description: cleanHtml(item.system?.description?.value || item.system?.description || "")
    })));

  const featureItems = await Promise.all(items
    .filter(i => featureTypes.has(i.type))
    .sort(sortDocuments)
    .map(async item => ({
      name: item.name,
      img: await getEmbeddedImage(item.img),
      type: item.type,
      uses: formatUses(item.system?.uses),
      activation: item.system?.activation?.type || "",
      description: cleanHtml(item.system?.description?.value || item.system?.description || "")
    })));

  const spells = await Promise.all(items
    .filter(i => i.type === "spell")
    .sort((a, b) => {
      const levelDiff = (a.system?.level ?? 0) - (b.system?.level ?? 0);
      if (levelDiff !== 0) return levelDiff;
      return a.name.localeCompare(b.name, game.i18n.lang);
    })
    .map(async item => ({
      name: item.name,
      img: await getEmbeddedImage(item.img),
      level: item.system?.level ?? 0,
      school: localizeConfig(item.system?.school, CONFIG.DND5E?.spellSchools),
      preparation: item.system?.preparation?.mode || "",
      prepared: Boolean(item.system?.preparation?.prepared),
      ritual: Boolean(item.system?.properties?.ritual),
      concentration: Boolean(item.system?.properties?.concentration),
      activation: item.system?.activation?.type || "",
      range: formatRange(item.system?.range),
      target: formatTarget(item.system?.target),
      duration: formatDuration(item.system?.duration),
      components: formatComponents(item.system?.properties, item.system?.materials),
      description: cleanHtml(item.system?.description?.value || item.system?.description || "")
    })));

  const toolItems = await Promise.all(items
    .filter(i => i.type === "tool")
    .sort(sortDocuments)
    .map(async item => ({
      name: item.name,
      img: await getEmbeddedImage(item.img),
      ability: localizeAbility(item.system?.ability),
      proficient: item.system?.proficient ?? item.system?.proficiency ?? 0,
      bonus: item.system?.bonus ?? item.system?.mod ?? item.system?.check?.bonus ?? "",
      description: cleanHtml(item.system?.description?.value || item.system?.description || "")
    })));

  const skillEntries = Object.entries(skills)
    .map(([key, value]) => ({
      key,
      label: localizeSkill(key),
      ability: localizeAbility(value?.ability),
      mod: signed(resolveSkillMod(value, abilities)),
      passive: resolvePassiveSkill(key, value, abilities),
      proficiency: formatSkillProficiency(value?.value)
    }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));

  const passiveEffectEntries = [];

  for (const effect of actorEffects.filter(isPassiveEffect)) {
    passiveEffectEntries.push({
      name: effect.name,
      img: await getEmbeddedImage(effect.img || effect.icon),
      source: effect.parent?.name || actor.name,
      description: cleanHtml(effect.description || effect.changes?.map(c => `${c.key}: ${c.value}`).join(" • ") || "")
    });
  }

  const passiveSourceTypes = new Set(["feat", "class", "subclass", "background", "race", "ancestry", "equipment", "weapon"]);
  for (const item of items.filter(i => passiveSourceTypes.has(i.type))) {
    for (const effect of getEmbeddedEffects(item).filter(isPassiveEffect)) {
      passiveEffectEntries.push({
        name: effect.name || item.name,
        img: await getEmbeddedImage(effect.img || effect.icon || item.img),
        source: item.name,
        description: cleanHtml(effect.description || effect.changes?.map(c => `${c.key}: ${c.value}`).join(" • ") || item.system?.description?.value || item.system?.description || "")
      });
    }
  }

  const passiveEffects = Array.from(new Map(
    passiveEffectEntries.map(effect => [`${effect.name}::${effect.source}`, effect])
  ).values());

  const featureGroups = groupBy(featureItems, item => titleCaseFeatureType(item.type));
  const spellGroups = groupBy(spells, spell => spell.level === 0 ? "Cantrips" : `Level ${spell.level}`);

  const classes = items.filter(i => i.type === "class").sort(sortDocuments);
  const subclasses = items.filter(i => i.type === "subclass").sort(sortDocuments);
  const speciesItem = items.filter(i => i.type === "race" || i.type === "ancestry").sort(sortDocuments)[0] ?? null;
  const backgroundItem = items.filter(i => i.type === "background").sort(sortDocuments)[0] ?? null;

  const featureSummary = {
    species: await buildFeatureSummaryCard(speciesItem, details.race || details.species || details.origin?.species || "—", "Species"),
    background: await buildFeatureSummaryCard(backgroundItem, details.background || details.origin?.background || "—", "Background"),
    class: await buildFeatureSummaryCollectionCard(classes, summarizeClasses(actor), "Class"),
    subclass: await buildFeatureSummaryCollectionCard(subclasses, subclasses.map(s => s.name).join(" / ") || "—", "Subclass", { hideIconWhenEmpty: true })
  };

  const biography = buildBiographyData(system);

  return {
    exportedAt: new Date().toLocaleString(),
    portrait,
    actorName: actor.name,
    header: {
      race: details.race || details.species || details.origin?.species || "—",
      classes: summarizeClasses(actor),
      background: details.background || details.origin?.background || "—",
      alignment: details.alignment || "—",
      level: summarizeLevel(actor),
      xp: system.details?.xp?.value ?? details.xp?.value ?? details.xp ?? "—",
      prof: signed(attributes.prof ?? 0),
      ac: attributes.ac?.value ?? attributes.ac ?? "—",
      hp: formatHp(attributes.hp),
      speed: formatMovement(attributes.movement),
      initiative: formatInitiative(attributes.init),
      spellcasting: localizeAbility(attributes.spellcasting),
      creatureType: formatTraitList(traits?.type, CONFIG.DND5E?.creatureTypes),
      passivePerception: resolvePassivePerception(skills, abilities)
    },
    details: {
      inspiration: attributes.inspiration ? "Yes" : "No",
      exhaustion: attributes.exhaustion ?? system.attributes?.exhaustion ?? 0,
      senses: flattenObjectValues(traits.senses),
      languages: formatTraitList(traits.languages, CONFIG.DND5E?.languages, { sort: true, titleCase: true }),
      resistances: formatTraitList(traits.dr, CONFIG.DND5E?.damageTypes, { sort: true, titleCase: true }),
      immunities: formatTraitList(traits.di, CONFIG.DND5E?.damageTypes, { sort: true, titleCase: true }),
      vulnerabilities: formatTraitList(traits.dv, CONFIG.DND5E?.damageTypes, { sort: true, titleCase: true }),
      conditionImmunities: formatTraitList(traits.ci, CONFIG.DND5E?.conditionTypes, { sort: true, titleCase: true }),
      currency: formatCurrency(currency),
      resources: formatResources(resources),
      abilities: Object.entries(abilities).map(([key, value]) => ({
        key: key.toUpperCase(),
        label: localizeAbility(key),
        value: value?.value ?? "—",
        mod: signed(value?.mod ?? 0),
        save: signed(resolveAbilitySave(value, attributes.prof))
      }))
    },
    skills: skillEntries,
    tools: toolItems,
    inventory,
    featureGroups,
    featureSummary,
    spellGroups,
    effects: passiveEffects.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)),
    biography
  };
}

function buildExportHtml(data) {
  const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "unknown";
  const detailsGrid = [
    ["Species", data.header.race],
    ["Classes", data.header.classes],
    ["Level", data.header.level],
    ["Background", data.header.background],
    ["Alignment", data.header.alignment],
    ["XP", data.header.xp],
    ["Proficiency Bonus", data.header.prof],
    ["Armor Class", data.header.ac],
    ["Hit Points", data.header.hp],
    ["Speed", data.header.speed],
    ["Initiative", data.header.initiative],
    ["Spellcasting Ability", data.header.spellcasting],
    ["Creature Type", data.header.creatureType || "—"],
    ["Languages", data.details.languages],
    ["Senses", data.details.senses],
    ["Resistances", data.details.resistances],
    ["Immunities", data.details.immunities],
    ["Vulnerabilities", data.details.vulnerabilities],
    ["Condition Immunities", data.details.conditionImmunities],
    ["Currency", data.details.currency],
    ...(data.details.resources ? [["Resources", data.details.resources]] : [])
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.actorName)} - ARCANEO Character Sheet Exporter</title>
  <style>
    :root {
      --bg: #0f1117;
      --panel: #141a25;
      --panel-2: #1b2332;
      --panel-3: #101521;
      --line: #36425d;
      --line-soft: rgba(122, 143, 187, 0.18);
      --gold: #d9b36c;
      --gold-soft: rgba(217, 179, 108, 0.14);
      --text: #edf2ff;
      --muted: #aab4c9;
      --shadow: rgba(0,0,0,0.45);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px;
      color: var(--text);
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top, rgba(139, 32, 48, 0.28), transparent 28%),
        radial-gradient(circle at bottom right, rgba(62, 88, 132, 0.18), transparent 28%),
        linear-gradient(180deg, #0e1016 0%, #0b0e14 60%, #080a0f 100%);
      min-height: 100vh;
    }
    .sheet {
      max-width: 1540px;
      margin: 0 auto;
      border: 1px solid var(--line);
      border-radius: 22px;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)), var(--panel-3);
      box-shadow: 0 24px 70px var(--shadow);
    }
    .hero {
      background:
        linear-gradient(180deg, rgba(120, 18, 32, 0.55), rgba(16, 21, 33, 0.92)),
        radial-gradient(circle at 50% 0%, rgba(255,255,255,0.06), transparent 45%);
      border-bottom: 1px solid var(--line);
      padding: 26px;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 22px;
      align-items: start;
    }
    .portrait {
      border: 1px solid rgba(217,179,108,0.28);
      border-radius: 18px;
      overflow: hidden;
      background: #121722;
      aspect-ratio: 0.78;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
    }
    .portrait img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .identity { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .title-row { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
    .title-block h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 3rem;
      line-height: 1;
      letter-spacing: 0.01em;
      color: #fffaf0;
      text-shadow: 0 2px 10px rgba(0,0,0,0.25);
    }
    .subtitle {
      margin-top: 8px;
      color: #f0d7a6;
      font-size: 1rem;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .meta-note { color: var(--muted); font-size: 0.92rem; margin-top: 6px; }
    .hero-stats {
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 12px;
    }
    .hero-card, .detail-card, .ability-card, .list-card, .bio-card, .sidebar-card, .section-block, .compact-card, .tool-card {
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .hero-card { padding: 14px 14px 12px; min-height: 84px; background: linear-gradient(180deg, rgba(16,21,33,0.72), rgba(24,31,46,0.82)); }
    .label {
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.11em;
      margin-bottom: 6px;
    }
    .hero-card .value, .detail-card .value { color: #ffffff; font-size: 1.06rem; line-height: 1.35; word-break: break-word; }
    .ability-bar { display: grid; grid-template-columns: repeat(7, minmax(96px, 1fr)); gap: 10px; margin-top: 4px; }
    .ability-chip {
      background: linear-gradient(180deg, rgba(15,20,31,0.92), rgba(30,37,52,0.9));
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px 10px;
      text-align: center;
    }
    .ability-chip .abbr { color: var(--gold); font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; }
    .ability-chip .score { font-size: 2rem; font-weight: 700; line-height: 1.1; margin-top: 4px; }
    .ability-chip .mods { margin-top: 5px; font-size: 0.9rem; color: var(--muted); }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      background: rgba(17,22,34,0.92);
    }
    .toolbar { padding: 18px 26px; border-bottom: 1px solid var(--line); }
    .tabs { padding: 18px 26px 0; }
    .toolbar button, .tab-button {
      appearance: none;
      cursor: pointer;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--text);
      background: linear-gradient(180deg, rgba(42,52,74,0.9), rgba(22,28,41,0.95));
      padding: 10px 16px;
      font-size: 0.95rem;
      transition: 140ms ease;
    }
    .toolbar button:hover, .tab-button:hover { transform: translateY(-1px); border-color: rgba(217,179,108,0.55); }
    .tab-button.active {
      background: linear-gradient(180deg, rgba(217,179,108,0.28), rgba(48,39,19,0.28));
      border-color: rgba(217,179,108,0.65);
      color: #fff5dd;
    }
    .tab-panel { display: none; padding: 26px; }
    .tab-panel.active { display: block; }
    .section-title { margin: 0 0 14px; font-family: Georgia, "Times New Roman", serif; font-size: 1.8rem; color: #fff7e8; }
    .section-subtitle { margin: 0 0 12px; font-size: 0.95rem; color: var(--gold); letter-spacing: 0.06em; text-transform: uppercase; }
    .details-layout { display: grid; grid-template-columns: 1.25fr 0.95fr; gap: 18px; }
    .detail-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .detail-card, .sidebar-card, .bio-card, .section-block { padding: 16px; }
    .sidebar-stack { display: grid; gap: 14px; }
    .hero-mini { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
    .hero-mini .mini {
      border: 1px solid var(--line-soft);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.02);
    }
    .hero-mini .mini .k { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .hero-mini .mini .v { margin-top: 4px; color: #fff; }
    .skill-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .skill-card {
      border: 1px solid var(--line-soft);
      border-radius: 14px;
      padding: 14px;
      background: rgba(255,255,255,0.02);
    }
    .skill-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .skill-name { font-weight: 700; color: #fff; }
    .skill-mod { color: var(--gold); font-weight: 700; }
    .skill-meta { margin-top: 6px; font-size: 0.9rem; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; }
    .tool-grid, .compact-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, 140px); justify-content: center; }
    .feature-summary-grid { display: grid; gap: 14px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 18px; }
    .tool-card { padding: 14px; text-align: center; width: 100%; }
    .tool-card .icon-wrap, .compact-card .icon-wrap {
      width: 68px;
      height: 68px;
      margin: 0 auto 10px;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.03);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tool-card .icon-wrap img, .compact-card .icon-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tool-card .name, .compact-card .name { color: #fff; font-weight: 700; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.5em; }
    .tool-card .meta { margin-top: 6px; color: var(--muted); font-size: 0.88rem; }
    .list-grid { display: grid; gap: 14px; }
    .list-card {
      padding: 14px;
      display: grid;
      grid-template-columns: 56px minmax(0,1fr);
      gap: 14px;
      align-items: start;
    }
    .item-icon {
      width: 56px;
      height: 56px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.03);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .item-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .item-icon .fallback, .compact-card .fallback, .tool-card .fallback { color: var(--gold); font-size: 1.2rem; }
    .card-title-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; flex-wrap: wrap; margin-bottom: 8px; }
    .card-title { margin: 0; color: #fffaf2; font-size: 1.08rem; }
    .pill-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 0.82rem;
      color: #e7edf9;
      background: rgba(66,82,117,0.28);
      border: 1px solid rgba(122,143,187,0.25);
    }
    .description, .bio-content { color: #dfe7f7; line-height: 1.6; font-size: 0.95rem; }
    .group-stack { display: grid; gap: 18px; }
    .compact-card {
      width: 140px;
      min-height: 120px;
      padding: 16px 12px 14px;
      text-align: center;
      position: relative;
      transition: 140ms ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
    }
    .compact-card:hover { transform: translateY(-2px); border-color: rgba(217,179,108,0.5); }
    .compact-card .meta { margin-top: 6px; color: var(--muted); font-size: 0.84rem; }
    .bio-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .empty-state {
      padding: 18px;
      border: 1px dashed var(--line);
      border-radius: 14px;
      color: var(--muted);
      background: rgba(255,255,255,0.015);
    }
    .arcaneo-footer {
      max-width: 1540px;
      margin: 18px auto 0;
      padding: 12px 18px 4px;
      text-align: center;
      font-size: 12px;
      color: var(--muted);
    }

    .footer {
      border-top: 1px solid var(--line);
      padding: 18px 26px 24px;
      color: var(--muted);
      font-size: 0.92rem;
      background: rgba(17,22,34,0.92);
    }
    @media (max-width: 1100px) {
      .hero-grid, .details-layout { grid-template-columns: 1fr; }
      .hero-stats { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
      .ability-bar { grid-template-columns: repeat(4, minmax(96px, 1fr)); }
    }
    @media (max-width: 760px) {
      body { padding: 12px; }
      .hero { padding: 18px; }
      .hero-stats { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .ability-bar { grid-template-columns: repeat(2, minmax(96px, 1fr)); }
      .list-card { grid-template-columns: 1fr; }
      .feature-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media print {
      body { background: #fff; color: #000; padding: 0; }
      .sheet { max-width: none; border: none; box-shadow: none; background: #fff; }
      .toolbar, .tabs { display: none !important; }
      .tab-panel { display: block !important; page-break-inside: avoid; }
      .hero, .footer { background: #fff; }
      .hero-card, .detail-card, .list-card, .bio-card, .sidebar-card, .section-block, .compact-card, .tool-card, .ability-chip, .skill-card {
        background: #fff; border-color: #bbb; color: #000;
      }
      .description, .bio-content, .hero-card .value, .detail-card .value, .skill-name, .tool-card .name, .compact-card .name, .hero-mini .mini .v { color: #000; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <header class="hero">
      <div class="hero-grid">
        <div class="portrait">${data.portrait ? `<img src="${data.portrait}" alt="Portrait of ${escapeHtml(data.actorName)}">` : `<div class="empty-state" style="margin:12px;">No image</div>`}</div>
        <div class="identity">
          <div class="title-row">
            <div class="title-block">
              <h1>${escapeHtml(data.actorName)}</h1>
              <div class="subtitle">
                <span>${escapeHtml(data.header.classes)}</span>
                <span>•</span>
                <span>${escapeHtml(data.header.race)}</span>
                <span>•</span>
                <span>${escapeHtml(data.header.alignment)}</span>
              </div>
              <div class="meta-note">ARCANEO Character Sheet Exporter • Foundry VTT • ${escapeHtml(data.exportedAt)}</div>
            </div>
          </div>
          <div class="hero-stats">
            ${renderHeadlineCard("Level", data.header.level)}
            ${renderHeadlineCard("Armor Class", data.header.ac)}
            ${renderHeadlineCard("Hit Points", data.header.hp)}
            ${renderHeadlineCard("Speed", data.header.speed)}
            ${renderHeadlineCard("Proficiency", data.header.prof)}
            ${renderHeadlineCard("Passive Perception", data.header.passivePerception)}
          </div>
          <div class="ability-bar">
            ${data.details.abilities.map(ability => `
              <div class="ability-chip">
                <div class="abbr">${escapeHtml(ability.key)}</div>
                <div class="score">${escapeHtml(ability.value)}</div>
                <div class="mods">Mod ${escapeHtml(ability.mod)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </header>
    <nav class="tabs">
      <button class="tab-button active" data-tab="details">Details</button>
      <button class="tab-button" data-tab="skills-tools">Skills &amp; Tools</button>
      <button class="tab-button" data-tab="inventory">Inventory</button>
      <button class="tab-button" data-tab="features">Features</button>
      <button class="tab-button" data-tab="spellbook">Spellbook</button>
      <button class="tab-button" data-tab="effects">Effects</button>
      <button class="tab-button" data-tab="biography">Biography</button>
    </nav>

    <section class="tab-panel active" data-panel="details">
      <h2 class="section-title">Details</h2>
      <div class="details-layout">
        <div>
          <div class="detail-grid">
            ${detailsGrid.map(([label, value]) => renderDetailCard(label, value)).join("\n")}
          </div>
        </div>
        <aside class="sidebar-stack">
          <div class="sidebar-card">
            <h3 class="section-subtitle">Saving Throws</h3>
            <div class="hero-mini">
              ${data.details.abilities.map(ability => `
                <div class="mini">
                  <div class="k">${escapeHtml(ability.key)}</div>
                  <div class="v">${escapeHtml(ability.save)}</div>
                </div>
              `).join("")}
            </div>
          </div>
          <div class="sidebar-card">
            <h3 class="section-subtitle">Summary</h3>
            <div class="hero-mini">
              <div class="mini"><div class="k">XP</div><div class="v">${escapeHtml(data.header.xp)}</div></div>
              <div class="mini"><div class="k">Spellcasting</div><div class="v">${escapeHtml(data.header.spellcasting)}</div></div>
              <div class="mini"><div class="k">Initiative</div><div class="v">${escapeHtml(data.header.initiative)}</div></div>
              <div class="mini"><div class="k">Inspiration</div><div class="v">${escapeHtml(data.details.inspiration)}</div></div>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <section class="tab-panel" data-panel="skills-tools">
      <h2 class="section-title">Skills &amp; Tools</h2>
      <section class="section-block">
        <h3 class="section-subtitle">Skills</h3>
        <div class="skill-grid">
          ${data.skills.length ? data.skills.map(skill => `
            <div class="skill-card">
              <div class="skill-head">
                <div class="skill-name">${escapeHtml(skill.label)}</div>
                <div class="skill-mod">${escapeHtml(skill.mod)}</div>
              </div>
              <div class="skill-meta">
                <span>${escapeHtml(skill.ability)}</span>
                <span>Passive ${escapeHtml(skill.passive)}</span>
                <span>${escapeHtml(skill.proficiency)}</span>
              </div>
            </div>
          `).join("") : `<div class="empty-state">No skills found.</div>`}
        </div>
      </section>
      <section class="section-block" style="margin-top:18px;">
        <h3 class="section-subtitle">Tools</h3>
        <div class="tool-grid">
          ${data.tools.length ? data.tools.map(tool => renderToolCard(tool)).join("\n") : `<div class="empty-state">No tools found.</div>`}
        </div>
      </section>
    </section>

    <section class="tab-panel" data-panel="inventory">
      <h2 class="section-title">Inventory</h2>
      <div class="list-grid">
        ${data.inventory.length ? data.inventory.map(item => renderRichListCard(item, [
          item.type && `Type: ${capitalize(item.type)}`,
          `Quantity: ${item.quantity}`,
          `Equipped: ${item.equipped ? "Yes" : "No"}`,
          `Attunement: ${item.attunement}`,
          `Rarity: ${formatDisplayText(item.rarity)}`,
          `Weight: ${item.weight}`,
          `Price: ${item.price}`,
          item.activation ? `Activation: ${item.activation}` : "",
          item.uses ? `Uses: ${item.uses}` : ""
        ], item.description)).join("\n") : `<div class="empty-state">No inventory items found.</div>`}
      </div>
    </section>

    <section class="tab-panel" data-panel="features">
      <h2 class="section-title">Features</h2>
      <div class="group-stack">
        ${Object.keys(data.featureGroups).length ? Object.entries(data.featureGroups).map(([groupName, entries]) => `
          <section class="section-block">
            <h3 class="section-subtitle">${escapeHtml(groupName)}</h3>
            <div class="compact-grid">
              ${entries.map(item => renderCompactCard(item, buildFeatureTooltip(item))).join("\n")}
            </div>
          </section>
        `).join("\n") : `<div class="empty-state">No features found.</div>`}
        <section class="section-block">
          <h3 class="section-subtitle">Character Summary</h3>
          <div class="feature-summary-grid">
            ${renderCompactCard(data.featureSummary.species, data.featureSummary.species.tooltip, "Species")}
            ${renderCompactCard(data.featureSummary.background, data.featureSummary.background.tooltip, "Background")}
            ${renderCompactCard(data.featureSummary.class, data.featureSummary.class.tooltip, "Class")}
            ${renderCompactCard(data.featureSummary.subclass, data.featureSummary.subclass.tooltip, "Subclass")}
          </div>
        </section>
      </div>
    </section>

    <section class="tab-panel" data-panel="spellbook">
      <h2 class="section-title">Spellbook</h2>
      <div class="group-stack">
        ${Object.keys(data.spellGroups).length ? Object.entries(data.spellGroups).map(([groupName, entries]) => `
          <section class="section-block">
            <h3 class="section-subtitle">${escapeHtml(groupName)}</h3>
            <div class="compact-grid">
              ${entries.map(spell => renderCompactCard(spell, buildSpellTooltip(spell), spell.prepared ? "Prepared" : "")).join("\n")}
            </div>
          </section>
        `).join("\n") : `<div class="empty-state">No spells found.</div>`}
      </div>
    </section>

    <section class="tab-panel" data-panel="effects">
      <h2 class="section-title">Effects</h2>
      <div class="compact-grid">
        ${data.effects.length ? data.effects.map(effect => renderCompactCard(effect, buildEffectTooltip(effect), effect.source)).join("\n") : `<div class="empty-state">No passive effects found.</div>`}
      </div>
    </section>

    <section class="tab-panel" data-panel="biography">
      <h2 class="section-title">Biography</h2>
      <div class="group-stack">
        ${data.biography.summaryFields.length ? `
          <section class="bio-card">
            <h3 class="section-subtitle">Character Details</h3>
            <div class="bio-grid">
              ${data.biography.summaryFields.map(([label, value]) => renderDetailCard(label, value)).join("\n")}
            </div>
          </section>
        ` : ""}
        ${data.biography.personalityFields.length ? `
          <section class="bio-card">
            <h3 class="section-subtitle">Personality</h3>
            <div class="bio-grid">
              ${data.biography.personalityFields.map(([label, value]) => renderDetailCard(label, value)).join("\n")}
            </div>
          </section>
        ` : ""}
        <article class="bio-card">
          <h3 class="section-subtitle">Backstory</h3>
          <div class="bio-content">${data.biography.backstory || `<p class="empty-state" style="margin:0;">No biography available.</p>`}</div>
        </article>
      </div>
    </section>

    <footer class="footer">
      Generated with ARCANEO Character Sheet Exporter • v${moduleVersion}
    </footer>
  </div>

  <script>
    const buttons = document.querySelectorAll('.tab-button');
    const panels = document.querySelectorAll('.tab-panel');
    buttons.forEach(button => {
      button.addEventListener('click', () => {
        const tab = button.dataset.tab;
        buttons.forEach(b => b.classList.toggle('active', b === button));
        panels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tab));
      });
    });
  </script>

</body>
</html>`;
}

async function getEmbeddedImage(imgPath) {
  if (!imgPath) return "";
  try {
    const absolutePath = /^(https?:|data:)/i.test(imgPath)
      ? imgPath
      : `${window.location.origin}/${imgPath.replace(/^\/+/, "")}`;

    const response = await fetch(absolutePath, { credentials: "include" });
    if (!response.ok) return absolutePath;

    const blob = await response.blob();
    return await blobToDataURL(blob);
  } catch (error) {
    console.warn(`${MODULE_ID} | Unable to embed image`, error);
    return imgPath;
  }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function summarizeClasses(actor) {
  const classes = getActorItems(actor).filter(i => i.type === "class");
  if (!classes.length) return actor.system?.details?.class || "—";
  return classes.map(c => `${c.name} ${c.system?.levels ?? ""}`.trim()).join(" / ");
}

function summarizeLevel(actor) {
  const classes = getActorItems(actor).filter(i => i.type === "class");
  if (!classes.length) return actor.system?.details?.level ?? "—";
  const total = classes.reduce((sum, c) => sum + Number(c.system?.levels ?? 0), 0);
  return total || actor.system?.details?.level || "—";
}

function formatHp(hp) {
  if (!hp) return "—";
  const value = hp.value ?? hp.current ?? "—";
  const max = hp.max ?? "—";
  const temp = hp.temp ? ` + ${hp.temp} temp` : "";
  return `${value} / ${max}${temp}`;
}

function formatMovement(movement) {
  if (!movement) return "—";
  const units = movement.units || "ft";
  const modeLabels = { walk: "Walk", burrow: "Burrow", climb: "Climb", fly: "Fly", swim: "Swim" };
  const parts = [];
  for (const [key, label] of Object.entries(modeLabels)) {
    const raw = movement[key];
    let value = raw;
    if (raw && typeof raw === "object") value = raw.value ?? raw.base ?? raw.total ?? "";
    if (value === null || value === undefined || value === "" || value === 0 || Number.isNaN(Number(value))) continue;
    parts.push(`${label} ${value}${units ? ` ${units}` : ""}`.trim());
  }
  if (movement.special && typeof movement.special === "string" && movement.special.trim()) parts.push(movement.special.trim());
  return parts.join(" • ") || "—";
}

function formatPrice(price) {
  if (!price) return "—";
  if (typeof price === "string") return price;
  if (typeof price === "number") return `${price} gp`;
  const value = price.value ?? "—";
  const denom = price.denomination ?? price.currency ?? "gp";
  return `${value} ${denom}`;
}

function formatUses(uses) {
  if (!uses) return "";
  const spent = Number(uses.spent ?? 0);
  const max = uses.max ?? "";
  const recovery = uses.recovery?.[0]?.period || uses.per || "";
  if (max === "" && !spent) return "";
  const current = max !== "" ? Math.max(Number(max) - spent, 0) : 0;
  return `${current}/${max}${recovery ? ` • recharge ${recovery}` : ""}`;
}

function normalizeAttunement(attunement) {
  const map = { 0: "No", 1: "Required", 2: "Attuned" };
  return map[attunement] ?? "—";
}

function formatRange(range) {
  if (!range) return "";
  if (typeof range === "string") return range;
  const value = range.value ?? "";
  const units = range.units ?? "";
  const long = range.long ? ` / ${range.long}` : "";
  return `${value}${value && units ? " " : ""}${units}${long}`.trim();
}

function formatTarget(target) {
  if (!target) return "";
  const count = target.value ?? target.count ?? "";
  const type = target.type ?? "";
  const units = target.units ?? "";
  return [count, units, type].filter(Boolean).join(" ");
}

function formatDuration(duration) {
  if (!duration) return "";
  if (typeof duration === "string") return duration;
  return [duration.value, duration.units, duration.special].filter(Boolean).join(" ");
}

function formatComponents(properties, materials) {
  if (!properties && !materials) return "";
  const bits = [];
  if (properties) {
    const entries = Object.entries(properties)
      .filter(([, active]) => Boolean(active))
      .map(([key]) => key.toUpperCase());
    bits.push(...entries);
  }
  if (materials?.value) bits.push(`Materials: ${stripHtml(cleanHtml(materials.value))}`);
  return bits.join(" • ");
}

function flattenObjectValues(obj) {
  if (!obj || typeof obj !== "object") return obj || "—";
  return Object.entries(obj)
    .filter(([, value]) => typeof value === "number" && value > 0)
    .map(([key, value]) => `${capitalize(key)} ${value}`)
    .join(" • ") || "—";
}

function formatTraitList(trait, dictionary = null, options = {}) {
  if (!trait) return "—";
  if (typeof trait === "string") {
    const cleaned = trait.trim();
    if (!cleaned || /^select /i.test(cleaned)) return "—";
    return options.titleCase ? toTitleCase(cleaned) : cleaned;
  }

  const values = [];
  const pushValue = (entry) => {
    if (entry === null || entry === undefined || entry === "") return;
    let text = entry;
    if (dictionary && typeof entry === "string") {
      const dictEntry = dictionary[entry];
      if (typeof dictEntry === "string") text = dictEntry;
      else if (dictEntry?.label) text = dictEntry.label;
    }
    text = String(text).trim();
    if (!text || /^select /i.test(text) || text === "[object Set]") return;
    values.push(options.titleCase ? toTitleCase(text) : text);
  };

  const value = trait.value;
  if (Array.isArray(value)) value.forEach(pushValue);
  else if (value instanceof Set) Array.from(value).forEach(pushValue);
  else if (value && typeof value === "object") {
    for (const [key, active] of Object.entries(value)) {
      if (active) pushValue(key);
    }
  } else if (value) pushValue(value);

  if (Array.isArray(trait.custom)) trait.custom.forEach(pushValue);
  else if (typeof trait.custom === "string") {
    trait.custom.split(/[;,]/).map(s => s.trim()).filter(Boolean).forEach(pushValue);
  }

  const deduped = [...new Set(values)];
  if (options.sort) deduped.sort((a, b) => a.localeCompare(b, game.i18n.lang));
  return deduped.join(", ") || "—";
}

function formatCurrency(currency) {
  const order = ["pp", "gp", "ep", "sp", "cp"];
  const values = order.filter(key => currency[key] !== undefined).map(key => `${key.toUpperCase()}: ${currency[key]}`);
  return values.join(" • ") || "—";
}

function formatResources(resources) {
  const labels = { primary: "Primary", secondary: "Secondary", tertiary: "Tertiary", legact: "Legendary Actions", legres: "Legendary Resistances" };
  const entries = Object.entries(resources ?? {})
    .filter(([, value]) => value && typeof value === "object" && (value.max !== undefined || value.value !== undefined))
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? capitalize(key),
      value: Number(value.value ?? 0),
      max: Number(value.max ?? 0)
    }))
    .filter(entry => entry.max > 0 || entry.value > 0)
    .map(entry => `${entry.label} ${entry.value}/${entry.max}`);
  return entries.join(" • ");
}

function cleanHtml(value) {
  if (!value) return "";
  return String(value).trim();
}

function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function renderHeadlineCard(label, value) {
  return `<article class="hero-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(formatDisplayText(value))}</div></article>`;
}

function renderDetailCard(label, value) {
  const rendered = typeof value === "string" && /<[^>]+>/.test(value) ? value : escapeHtml(formatDisplayText(value));
  return `<article class="detail-card"><div class="label">${escapeHtml(label)}</div><div class="value">${rendered}</div></article>`;
}

function renderRichListCard(item, pills, description) {
  const pillMarkup = pills.filter(Boolean).map(text => `<span class="pill">${escapeHtml(text)}</span>`).join("");
  const icon = item.img ? `<img src="${item.img}" alt="">` : `<div class="fallback">✦</div>`;
  return `
    <article class="list-card">
      <div class="item-icon">${icon}</div>
      <div class="card-main">
        <div class="card-title-row">
          <h3 class="card-title">${escapeHtml(item.name)}</h3>
        </div>
        ${pillMarkup ? `<div class="pill-row">${pillMarkup}</div>` : ""}
        ${description ? `<div class="description">${description}</div>` : ""}
      </div>
    </article>
  `;
}

function renderCompactCard(item, tooltip, meta = "") {
  const icon = item.img ? `<img src="${item.img}" alt="">` : `<div class="fallback">✦</div>`;
  return `
    <article class="compact-card" title="${escapeHtml(tooltip)}">
      <div class="icon-wrap">${icon}</div>
      <div class="name">${escapeHtml(item.name)}</div>
      ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
    </article>
  `;
}

function renderToolCard(tool) {
  const icon = tool.img ? `<img src="${tool.img}" alt="">` : `<div class="fallback">✦</div>`;
  const profText = tool.proficient ? "Proficient" : "Not proficient";
  const metaBits = [tool.ability !== "—" ? tool.ability : "", profText, tool.bonus !== "" ? `Bonus ${tool.bonus}` : ""].filter(Boolean);
  return `
    <article class="tool-card" title="${escapeHtml(stripHtml(tool.description) || tool.name)}">
      <div class="icon-wrap">${icon}</div>
      <div class="name">${escapeHtml(tool.name)}</div>
      <div class="meta">${escapeHtml(metaBits.join(" • ") || "—")}</div>
    </article>
  `;
}

function buildFeatureTooltip(item) {
  const parts = [
    titleCaseFeatureType(item.type),
    item.activation ? `Activation: ${item.activation}` : "",
    item.uses ? `Uses: ${item.uses}` : "",
    stripHtml(item.description)
  ].filter(Boolean);
  return parts.join("\n");
}

function buildSpellTooltip(spell) {
  const parts = [
    spell.school,
    spell.preparation ? `Preparation: ${capitalize(spell.preparation)}${spell.prepared ? " (Prepared)" : ""}` : "",
    spell.ritual ? "Ritual" : "",
    spell.concentration ? "Concentration" : "",
    spell.activation ? `Activation: ${spell.activation}` : "",
    spell.range ? `Range: ${spell.range}` : "",
    spell.target ? `Target: ${spell.target}` : "",
    spell.duration ? `Duration: ${spell.duration}` : "",
    spell.components ? `Components: ${spell.components}` : "",
    stripHtml(spell.description)
  ].filter(Boolean);
  return parts.join("\n");
}

function buildEffectTooltip(effect) {
  return [effect.source ? `Source: ${effect.source}` : "", stripHtml(effect.description)].filter(Boolean).join("\n");
}

async function buildFeatureSummaryCard(item, fallbackName, fallbackMeta = "") {
  const name = fallbackName || item?.name || "—";
  const description = cleanHtml(item?.system?.description?.value || item?.system?.description || "");
  return {
    name,
    img: item ? await getEmbeddedImage(item.img) : "",
    tooltip: [fallbackMeta, stripHtml(description)].filter(Boolean).join("\n") || `${fallbackMeta}: ${name}`
  };
}

async function buildFeatureSummaryCollectionCard(items, fallbackName, fallbackMeta = "", options = {}) {
  const docs = Array.isArray(items) ? items : [];
  const first = docs[0] ?? null;
  const name = docs.length ? docs.map(item => item.name).join(" / ") : (fallbackName || "—");
  const description = docs.map(item => cleanHtml(item.system?.description?.value || item.system?.description || "")).filter(Boolean).join("\n\n");
  return {
    name,
    img: docs.length && !(options.hideIconWhenEmpty && name === "—") ? await getEmbeddedImage(first?.img) : "",
    tooltip: [fallbackMeta, stripHtml(description)].filter(Boolean).join("\n") || `${fallbackMeta}: ${name}`
  };
}

function buildBiographyData(system) {
  const details = system.details ?? {};
  const physicalPairs = [
    ["Age", details.age],
    ["Height", details.height],
    ["Weight", details.weight],
    ["Eyes", details.eyes],
    ["Skin", details.skin],
    ["Hair", details.hair],
    ["Gender", details.gender],
    ["Faith", details.faith],
    ["Appearance", cleanHtml(details.appearance)]
  ].filter(([, value]) => hasContent(value));

  const personalityPairs = [
    ["Personality Traits", details.trait],
    ["Ideals", details.ideal],
    ["Bonds", details.bond],
    ["Flaws", details.flaw]
  ].filter(([, value]) => hasContent(value));

  const backstory = cleanHtml(
    details.biography?.value ||
    details.biography ||
    system.biography?.value ||
    system.biography ||
    ""
  );

  return {
    summaryFields: physicalPairs.map(([label, value]) => [label, typeof value === "string" ? value : formatDisplayText(value)]),
    personalityFields: personalityPairs.map(([label, value]) => [label, typeof value === "string" ? value : formatDisplayText(value)]),
    backstory
  };
}

function hasContent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function isPassiveEffect(effect) {
  if (!effect || effect.disabled) return false;
  const statuses = effect.statuses;
  const statusCount = statuses instanceof Set ? statuses.size : Array.isArray(statuses) ? statuses.length : 0;
  if (statusCount > 0) return false;

  const keyText = (effect.changes ?? []).map(c => `${c.key ?? ""} ${c.value ?? ""}`.toLowerCase()).join(" ");
  const systemStatusHints = ["statuses", "condition", "specialStatus", "death", "concentration", "exhaustion"];
  if (systemStatusHints.some(h => keyText.includes(h.toLowerCase()))) return false;

  const parent = effect.parent;
  const parentType = parent?.type;
  if (parentType && ["spell", "consumable", "loot", "tool", "backpack", "container"].includes(parentType)) return false;

  return true;
}

function signed(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `${num >= 0 ? "+" : ""}${num}`;
}

function resolveAbilitySave(ability, profValue = 0) {
  const save = Number(ability?.save);
  if (Number.isFinite(save)) return save;
  const proficient = Number(ability?.proficient ?? ability?.saveProf ?? 0);
  const mod = Number(ability?.mod ?? 0);
  const prof = Number(profValue ?? 0);
  if (Number.isFinite(mod)) return mod + (proficient ? prof : 0);
  return 0;
}

function resolveSkillMod(skill, abilities) {
  const value = Number(skill?.total ?? skill?.mod ?? skill?.passiveBonus);
  if (Number.isFinite(value)) return value;
  const abil = abilities?.[skill?.ability ?? ""];
  return Number(abil?.mod ?? 0);
}

function resolvePassiveSkill(key, skill, abilities) {
  const passive = Number(skill?.passive);
  if (Number.isFinite(passive) && passive > 0) return passive;
  const mod = resolveSkillMod(skill, abilities);
  return 10 + Number(mod || 0);
}

function resolvePassivePerception(skills, abilities) {
  const per = skills?.prc;
  return resolvePassiveSkill("prc", per, abilities);
}

function formatSkillProficiency(value) {
  const map = {
    0: "No proficiency",
    0.5: "Half proficiency",
    1: "Proficient",
    2: "Expertise"
  };
  return map[value] ?? (value ? `Proficiency x${value}` : "No proficiency");
}

function formatInitiative(init) {
  if (init === null || init === undefined) return "—";
  if (typeof init === "number") return signed(init);
  const value = Number(init.value ?? init.bonus ?? init.mod);
  return Number.isFinite(value) ? signed(value) : "—";
}

function sortDocuments(a, b) {
  const aSort = Number(a.sort ?? 0);
  const bSort = Number(b.sort ?? 0);
  if (aSort !== bSort) return aSort - bSort;
  return a.name.localeCompare(b.name, game.i18n.lang);
}

function titleCaseFeatureType(value) {
  const map = {
    feat: "Features",
    class: "Classes",
    subclass: "Subclasses",
    background: "Background",
    race: "Species",
    ancestry: "Ancestry"
  };
  return map[value] ?? capitalize(value);
}

function capitalize(value) {
  if (!value && value !== 0) return "—";
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toTitleCase(value) {
  return String(value)
    .split(/\s+/)
    .map(word => word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word)
    .join(" ")
    .replace(/'S\b/g, "'s")
    .replace(/\bCant\b/i, "Cant");
}

function localizeConfig(key, dictionary) {
  if (!key) return "";
  const entry = dictionary?.[key];
  if (typeof entry === "string") return entry;
  if (entry?.label) return entry.label;
  return capitalize(key);
}

function localizeAbility(key) {
  const map = CONFIG.DND5E?.abilities ?? {};
  const entry = map?.[key];
  if (typeof entry === "string") return entry;
  if (entry?.label) return entry.label;
  return key ? capitalize(key) : "—";
}

function localizeSkill(key) {
  const map = CONFIG.DND5E?.skills ?? {};
  const entry = map?.[key];
  if (typeof entry === "string") return entry;
  if (entry?.label) return entry.label;
  return capitalize(key);
}

function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    (acc[key] ??= []).push(item);
    return acc;
  }, {});
}

function formatDisplayText(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
