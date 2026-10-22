// Import de PostgreSQL pour enregistrer les analyses.

const { Pool } = require("pg");

// Express permet de créer le serveur web et les différentes routes.

const express = require("express");

// Axios télécharge le contenu des pages web en HTTP/HTTPS.

const axios = require("axios");

// Cheerio permet de parcourir le HTML reçu comme avec jQuery.

const cheerio = require("cheerio");

// robots-parser sert à lire robots.txt et à vérifier les pages autorisées.

const robotsParser = require("robots-parser");

// Création de l'application Express.

const app = express();

// Paramètres généraux du serveur et du crawler.

const PORT = 3000;

// Temps maximum d'attente pour une requête HTTP : 10 secondes.

const TIMEOUT = 10000;

// Pause de 1 seconde entre deux pages pour éviter de surcharger le site.

const RATE_LIMIT_MS = 1000;

// Nom envoyé au site pour identifier notre crawler.

const USER_AGENT = "MonCrawlerSEO/1.0";

// ============================================================

// BASE DE DONNÉES

// Connexion à PostgreSQL.

// Les analyses, pages visitées et mots-clés y seront sauvegardés.

// ============================================================

const pool = new Pool({

    user: "postgres",

    host: "localhost",

    database: "crawler_seo",

    password: "postgres",

    port: 5430

});

// Petite requête de test au lancement pour vérifier que PostgreSQL répond.

pool.query("SELECT NOW()")

    .then(result => {

        console.log("Connexion PostgreSQL OK :", result.rows[0]);

    })

    .catch(error => {

        console.error("Erreur PostgreSQL :", error.message);

    });

// ============================================================

// FILTRAGE DES MOTS

// Liste de mots très courants ("stop words") que l'on ne souhaite pas

// considérer comme de vrais mots-clés SEO.

// ============================================================

const motsInutiles = new Set([

    // Français

    "le", "la", "les", "un", "une", "des",

    "de", "du", "dans", "sur", "avec",

    "pour", "par", "et", "ou", "mais",

    "est", "sont", "ce", "ces", "cet",

    "cette", "au", "aux", "en", "à",

    "a", "que", "qui", "se", "sa",

    "son", "ses", "leur", "leurs",

    "plus", "ne", "pas", "nous", "vous",

    "ils", "elles", "il", "elle", "je",

    "tu", "on", "mes", "tes", "nos",

    "vos", "mon", "ton", "notre", "votre",

    "être", "avoir", "fait", "faire",

    "comme", "tout", "tous", "toutes",

    "très", "aussi", "encore", "entre",

    "sans", "chez", "vers", "après",

    "avant", "si", "donc", "car",

    // Anglais

    "the", "a", "an", "and", "or",

    "of", "to", "in", "on", "for",

    "with", "is", "are", "this",

    "that", "by", "from", "as",

    "at", "be", "was", "were",

    "has", "have", "had", "you",

    "your", "we", "our", "they",

    "their", "it", "its", "not",

    "but", "more", "can", "will",

    "all", "about", "into", "than"

]);

// Pondération des différentes zones HTML.

// Un mot présent dans <title> compte davantage qu'un mot présent dans un alt.

const POIDS_SEO = {

    title: 10,

    keywords: 8,

    description: 7,

    h1: 6,

    h2: 5,

    h3: 4,

    h4: 3,

    h5: 2,

    h6: 1,

    alt: 1

};

// Fonction utilitaire qui crée une pause asynchrone.

function attendre(ms) {

    return new Promise(resolve => setTimeout(resolve, ms));

}

// Nettoie et valide un mot avant de l'ajouter au classement.

// Retourne null si le mot doit être ignoré.

function nettoyerMot(mot) {

    const motNettoye = String(mot)

        .toLowerCase()

        .trim();

    // On ignore les mots de moins de 3 caractères.

    if (motNettoye.length < 3) {

        return null;

    }

    // On ignore les nombres seuls.

    if (/^\d+$/.test(motNettoye)) {

        return null;

    }

    // On ignore les mots très courants.

    if (motsInutiles.has(motNettoye)) {

        return null;

    }

    return motNettoye;

}

// Découpe un texte en mots puis ajoute leur fréquence et leur score SEO.

// "poids" dépend de la balise dans laquelle le mot a été trouvé.

function ajouterMots(texte, poids, mots) {

    if (!texte) {

        return;

    }

    // On conserve les lettres, nombres, espaces, apostrophes et tirets.

    const texteNettoye = String(texte)

        .toLowerCase()

        .replace(/[^\p{L}\p{N}\s'-]/gu, " ");

    // Après nettoyage, on découpe la chaîne en mots séparés par des espaces.

    const listeMots = texteNettoye.split(/\s+/);

    listeMots.forEach(mot => {

        const motNettoye = nettoyerMot(mot);

        if (!motNettoye) {

            return;

        }

        if (!mots[motNettoye]) {

            mots[motNettoye] = {

                frequence: 0,

                score: 0

            };

        }

        // À chaque apparition : +1 en fréquence et +poids dans le score.

        mots[motNettoye].frequence += 1;

        mots[motNettoye].score += poids;

    });

}

// ============================================================

// EXTRACTION DES LIENS

// Récupère tous les liens internes présents dans une page.

// Les liens externes et les protocoles autres que HTTP/HTTPS sont ignorés.

// ============================================================

function extraireLiens($, urlPage) {

    const liens = [];

    const origine = new URL(urlPage);

    // On parcourt chaque balise <a> qui possède un attribut href.

    $("a[href]").each((index, element) => {

        const href = $(element).attr("href");

        if (!href) {

            return;

        }

        try {

            const nouvelleUrl = new URL(href, urlPage);

            // Un crawler de pages web ne suit que HTTP/HTTPS.

            if (

                nouvelleUrl.protocol !== "http:" &&

                nouvelleUrl.protocol !== "https:"

            ) {

                return;

            }

            // On reste sur le même site et le même port.

            if (nouvelleUrl.host !== origine.host) {

                return;

            }

            // Une ancre ne représente pas une nouvelle page.

            nouvelleUrl.hash = "";

            liens.push(nouvelleUrl.href);

        } catch (error) {

            // URL invalide : on ignore simplement le lien.

        }

    });

    // Set supprime les doublons avant de retourner la liste finale.

    return [...new Set(liens)];

}

// ============================================================

// ANALYSE D'UNE PAGE

// Télécharge une page, lit son HTML et calcule le score des mots-clés.

// Cette fonction retourne aussi les liens internes trouvés sur la page.

// ============================================================

async function analyserPage(url) {

    const mots = {};

    // Téléchargement de la page demandée.

    const response = await axios.get(url, {

        timeout: TIMEOUT,

        maxRedirects: 5,

        headers: {

            "User-Agent": USER_AGENT,

            "Accept": "text/html,application/xhtml+xml"

        }

    });

    // Vérification du type de contenu : on ne veut analyser que des pages HTML.

    const contentType = String(

        response.headers["content-type"] || ""

    ).toLowerCase();

    if (

        !contentType.includes("text/html") &&

        !contentType.includes("application/xhtml+xml")

    ) {

        throw new Error("La ressource n'est pas une page HTML");

    }

    // Chargement du HTML dans Cheerio pour pouvoir sélectionner les balises.

    const $ = cheerio.load(response.data);

    // <title> : poids 10

    ajouterMots(

        $("title").first().text().trim(),

        POIDS_SEO.title,

        mots

    );

    // <meta name="keywords"> : poids 8

    ajouterMots(

        $('meta[name="keywords"]').attr("content") || "",

        POIDS_SEO.keywords,

        mots

    );

    // <meta name="description"> : poids 7

    ajouterMots(

        $('meta[name="description"]').attr("content") || "",

        POIDS_SEO.description,

        mots

    );

    // <h1> à <h6> : poids 6 à 1

    const balisesTitres = ["h1", "h2", "h3", "h4", "h5", "h6"];

    for (const balise of balisesTitres) {

        $(balise).each((index, element) => {

            ajouterMots(

                $(element).text().trim(),

                POIDS_SEO[balise],

                mots

            );

        });

    }

    // Attribut alt des images : poids 1

    $("img[alt]").each((index, element) => {

        ajouterMots(

            $(element).attr("alt") || "",

            POIDS_SEO.alt,

            mots

        );

    });

    // Transformation de l'objet "mots" en tableau trié par score décroissant.

    const classement = Object.entries(mots)

        .sort((a, b) => b[1].score - a[1].score);

    // On extrait les liens à partir du HTML déjà téléchargé.

    // Ainsi, chaque page n'est téléchargée qu'une seule fois.

    const liens = extraireLiens($, url);

    return {

        classement,

        liens

    };

}

// ============================================================

// ROBOTS.TXT

// Télécharge le fichier robots.txt du site afin de savoir quelles pages

// notre crawler est autorisé à visiter.

// ============================================================

async function chargerRobots(urlDepart) {

    try {

        const url = new URL(urlDepart);

        const robotsUrl = `${url.origin}/robots.txt`;

        console.log("Lecture de :", robotsUrl);

        const response = await axios.get(robotsUrl, {

            timeout: TIMEOUT,

            maxRedirects: 5,

            headers: {

                "User-Agent": USER_AGENT

            }

        });

        return robotsParser(robotsUrl, response.data);

    } catch (error) {

        console.log("robots.txt absent ou inaccessible");

        return null;

    }

}

// Convertit les erreurs techniques Axios en messages plus faciles à lire.

function formaterErreurCrawler(error) {

    if (error.response) {

        return `HTTP ${error.response.status}`;

    }

    if (error.code === "ECONNABORTED") {

        return "Timeout";

    }

    if (error.code === "ENOTFOUND") {

        return "Nom de domaine introuvable";

    }

    if (error.code === "ECONNREFUSED") {

        return "Connexion refusée";

    }

    return error.message;

}

// ============================================================

// CRAWL COMPLET DU SITE

// Fonction principale du robot :

// - garde une file d'URLs à visiter,

// - évite de visiter deux fois la même page,

// - respecte robots.txt,

// - analyse les pages jusqu'à la limite demandée.

// ============================================================

async function crawlerSite(urlDepart, limite = 10) {

    // File d'attente : la première page à visiter est l'URL donnée par l'utilisateur.

    const aVisiter = [urlDepart];

    // Ensemble des URLs déjà traitées pour éviter les doublons.

    const traitees = new Set();

    // Tableau qui stockera le résultat de chaque page analysée.

    const resultats = [];

    // Lecture du robots.txt avant de commencer le crawl.

    const robots = await chargerRobots(urlDepart);

    while (

        aVisiter.length > 0 &&

        resultats.length < limite

    ) {

        // shift() retire la première URL de la file d'attente.

        const url = aVisiter.shift();

        if (traitees.has(url)) {

            continue;

        }

        // Une URL traitée ne sera plus ajoutée plus tard.

        traitees.add(url);

        if (robots) {

            // Vérifie si notre User-Agent a le droit de visiter cette URL.

            const autorise = robots.isAllowed(url, USER_AGENT);

            if (autorise === false) {

                console.log("Interdit par robots.txt :", url);

                continue;

            }

        }

        console.log("\nCrawl :", url);

        try {

            // Analyse de la page courante et récupération de ses liens internes.

            const { classement, liens } = await analyserPage(url);

            resultats.push({

                url,

                classement

            });

            // Les nouveaux liens trouvés sont ajoutés à la file s'ils sont inconnus.

            liens.forEach(lien => {

                if (

                    !traitees.has(lien) &&

                    !aVisiter.includes(lien)

                ) {

                    aVisiter.push(lien);

                }

            });

            // Une pause entre deux pages afin de ne pas surcharger le site.

            if (

                aVisiter.length > 0 &&

                resultats.length < limite

            ) {

                await attendre(RATE_LIMIT_MS);

            }

        } catch (error) {

            console.log(

                `Page ignorée : ${url} - ${formaterErreurCrawler(error)}`

            );

        }

    }

    return resultats;

}

// ============================================================

// VALIDATION D'URL

// Vérifie que l'utilisateur a fourni une URL HTTP/HTTPS valide

// et supprime l'ancre (#...) qui ne change pas réellement de page.

// ============================================================

function normaliserUrl(url) {

    try {

        const objetUrl = new URL(url);

        if (

            objetUrl.protocol !== "http:" &&

            objetUrl.protocol !== "https:"

        ) {

            return null;

        }

        objetUrl.hash = "";

        return objetUrl.href;

    } catch (error) {

        return null;

    }

}

// ============================================================

// FUSION DES RÉSULTATS

// Additionne les fréquences et scores obtenus sur toutes les pages du site.

// ============================================================

function fusionnerResultats(resultats) {

    const global = {};

    resultats.forEach(page => {

        page.classement.forEach(([mot, infos]) => {

            if (!global[mot]) {

                global[mot] = {

                    frequence: 0,

                    score: 0

                };

            }

            global[mot].frequence += infos.frequence;

            global[mot].score += infos.score;

        });

    });

    // On garde seulement les mots présents au moins deux fois.

    return Object.entries(global)

        .filter(([, infos]) => infos.frequence >= 2)

        .sort((a, b) => b[1].score - a[1].score);

}

// Sécurise le texte avant de l'afficher dans le HTML.

// Cela évite qu'une valeur récupérée sur un site soit interprétée comme du HTML.

function echapperHtml(texte) {

    return String(texte)

        .replaceAll("&", "&amp;")

        .replaceAll("<", "&lt;")

        .replaceAll(">", "&gt;")

        .replaceAll('"', "&quot;")

        .replaceAll("'", "&#039;");

}

// Génère le HTML du nuage de mots.

// Plus le score SEO est élevé, plus le mot sera affiché en grand.

function genererNuage(classement) {

    if (classement.length === 0) {

        return "<p>Aucun mot-clé suffisamment fréquent n'a été trouvé.</p>";

    }

    const topMots = classement.slice(0, 50);

    const scoreMax = topMots[0][1].score;

    return topMots

        .map(([mot, infos]) => {

            const taille = 16 + (infos.score / scoreMax) * 34;

            return `

                <span

                    class="mot-cloud"

                    style="font-size: ${taille.toFixed(1)}px;"

                    title="Fréquence : ${infos.frequence} | Score : ${infos.score}"

                >

                    ${echapperHtml(mot)}

                </span>

            `;

        })

        .join("");

}

// Génère la partie HTML qui résume chaque page crawlée

// avec ses cinq mots-clés ayant le meilleur score.

function genererListePages(resultats) {

    if (resultats.length === 0) {

        return "<p>Aucune page n'a été analysée.</p>";

    }

    return resultats

        .map((page, index) => {

            const top5 = page.classement

                .slice(0, 5)

                .map(([mot, infos]) => {

                    return `${echapperHtml(mot)} (${infos.score})`;

                })

                .join(", ");

            return `

                <article class="page-crawlee">

                    <h3>Page ${index + 1}</h3>

                    <p>

                        <strong>URL :</strong>

                        ${echapperHtml(page.url)}

                    </p>

                    <p>

                        <strong>Top mots-clés :</strong>

                        ${top5 || "Aucun mot trouvé"}

                    </p>

                </article>

            `;

        })

        .join("");

}

// ============================================================

// ENREGISTREMENT EN BASE

// Sauvegarde une analyse complète dans PostgreSQL.

// Une transaction est utilisée : soit tout est enregistré, soit rien.

// ============================================================

async function enregistrerAnalyse(

    url,

    resultats,

    classementGlobal

) {

    // On prend une connexion dédiée dans le pool PostgreSQL.

    const client = await pool.connect();

    try {

        // Début de la transaction SQL.

        await client.query("BEGIN");

        const analyseResult = await client.query(

            `

            INSERT INTO analyses (url)

            VALUES ($1)

            RETURNING id

            `,

            [url]

        );

        // On récupère l'identifiant de l'analyse qui vient d'être créée.

        const analyseId = analyseResult.rows[0].id;

        for (const page of resultats) {

            await client.query(

                `

                INSERT INTO pages (

                    analyse_id,

                    url

                )

                VALUES ($1, $2)

                `,

                [

                    analyseId,

                    page.url

                ]

            );

        }

        for (const [mot, infos] of classementGlobal) {

            await client.query(

                `

                INSERT INTO mots (

                    analyse_id,

                    mot,

                    frequence,

                    score

                )

                VALUES ($1, $2, $3, $4)

                `,

                [

                    analyseId,

                    mot,

                    infos.frequence,

                    infos.score

                ]

            );

        }

        // Toutes les insertions se sont bien passées : on valide la transaction.

        await client.query("COMMIT");

        console.log(

            "Analyse enregistrée avec l'id :",

            analyseId

        );

        return analyseId;

    } catch (error) {

        // En cas d'erreur, on annule toutes les requêtes de cette transaction.

        await client.query("ROLLBACK");

        throw error;

    } finally {

        // La connexion est toujours rendue au pool, succès ou erreur.

        client.release();

    }

}

// ============================================================

// ROUTE : PAGE D'ACCUEIL

// Affiche le formulaire permettant de saisir une URL et une limite de pages.

// ============================================================

app.get("/", (req, res) => {

    res.send(`

        <!DOCTYPE html>

        <html lang="fr">

        <head>

            <meta charset="UTF-8">

            <meta

                name="viewport"

                content="width=device-width, initial-scale=1.0"

            >

            <title>Crawler SEO</title>

            <style>

                * {

                    box-sizing: border-box;

                }

                body {

                    margin: 0;

                    font-family: Arial, sans-serif;

                    background: #f4f4f4;

                    color: #222;

                }

                main {

                    min-height: 100vh;

                    display: flex;

                    justify-content: center;

                    align-items: center;

                    padding: 20px;

                }

                .container {

                    width: 100%;

                    max-width: 700px;

                    background: white;

                    padding: 35px;

                    border-radius: 12px;

                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);

                }

                h1 {

                    text-align: center;

                    margin-top: 0;

                }

                .description {

                    text-align: center;

                    margin-bottom: 30px;

                }

                form {

                    display: flex;

                    flex-direction: column;

                    gap: 12px;

                }

                label {

                    font-weight: bold;

                }

                input,

                select,

                button {

                    width: 100%;

                    padding: 12px;

                    font-size: 16px;

                    border-radius: 6px;

                }

                input,

                select {

                    border: 1px solid #777;

                    background: white;

                }

                button {

                    margin-top: 10px;

                    border: none;

                    background: #222;

                    color: white;

                    cursor: pointer;

                }

                button:hover {

                    background: #444;

                }

                input:focus,

                select:focus,

                button:focus,

                a:focus {

                    outline: 3px solid #777;

                    outline-offset: 2px;

                }

                .historique {

                    display: block;

                    text-align: center;

                    margin-top: 25px;

                    color: #222;

                    font-weight: bold;

                }

                @media (max-width: 600px) {

                    .container {

                        padding: 20px;

                    }

                    h1 {

                        font-size: 26px;

                    }

                }

            </style>

        </head>

        <body>

            <main>

                <section class="container">

                    <h1>Crawler SEO</h1>

                    <p class="description">

                        Analysez les principaux mots-clés d'un site web.

                    </p>

                    <form

                        method="GET"

                        action="/analyse"

                    >

                        <label for="url">

                            URL du site

                        </label>

                        <input

                            id="url"

                            type="url"

                            name="url"

                            placeholder="https://example.com"

                            required

                        >

                        <label for="limite">

                            Nombre maximum de pages

                        </label>

                        <select

                            id="limite"

                            name="limite"

                        >

                            <option value="1">

                                1 page

                            </option>

                            <option value="5">

                                5 pages

                            </option>

                            <option

                                value="10"

                                selected

                            >

                                10 pages

                            </option>

                            <option value="20">

                                20 pages

                            </option>

                        </select>

                        <button type="submit">

                            Lancer l'analyse

                        </button>

                    </form>

                    <a

                        class="historique"

                        href="/historique"

                    >

                        Voir l'historique

                    </a>

                </section>

            </main>

        </body>

        </html>

    `);

});

// ============================================================

// ROUTE : /analyse

// Récupère les valeurs du formulaire, lance le crawler,

// calcule le classement global, sauvegarde puis affiche les résultats.

// ============================================================

app.get("/analyse", async (req, res) => {

    try {

        // L'URL vient du paramètre ?url=... envoyé par le formulaire.

        const url = normaliserUrl(req.query.url);

        if (!url) {

            return res.status(400).send(`

                <!DOCTYPE html>

                <html lang="fr">

                <head>

                    <meta charset="UTF-8">

                    <title>URL invalide</title>

                </head>

                <body>

                    <h1>URL invalide</h1>

                    <p>

                        Veuillez entrer une URL complète,

                        par exemple https://example.com

                    </p>

                    <a href="/">Retour</a>

                </body>

                </html>

            `);

        }

        // Conversion du nombre de pages demandé en entier.

        let limite = Number.parseInt(req.query.limite, 10);

        if (![1, 5, 10, 20].includes(limite)) {

            limite = 10;

        }

        console.log("\n=============================");

        console.log("NOUVEAU CRAWL");

        console.log("=============================");

        console.log("Site :", url);

        console.log("Limite :", limite);

        // Lancement réel du crawl du site.

        const resultats = await crawlerSite(url, limite);

        if (resultats.length === 0) {

            throw new Error(

                "Aucune page HTML n'a pu être analysée sur ce site."

            );

        }

        const classementGlobal =

            fusionnerResultats(resultats);

        const nuage =

            genererNuage(classementGlobal);

        const listePages =

            genererListePages(resultats);

        const analyseId =

            await enregistrerAnalyse(

                url,

                resultats,

                classementGlobal

            );

        res.send(`

            <!DOCTYPE html>

            <html lang="fr">

            <head>

                <meta charset="UTF-8">

                <meta

                    name="viewport"

                    content="width=device-width, initial-scale=1.0"

                >

                <title>Résultats du crawler</title>

                <style>

                    * {

                        box-sizing: border-box;

                    }

                    body {

                        font-family: Arial, sans-serif;

                        max-width: 1100px;

                        margin: auto;

                        padding: 30px;

                        background: #f4f4f4;

                        color: #222;

                    }

                    h1 {

                        text-align: center;

                    }

                    .info,

                    .cloud,

                    .page-crawlee {

                        background: white;

                        padding: 20px;

                        margin-bottom: 20px;

                        border-radius: 10px;

                    }

                    .cloud {

                        text-align: center;

                        line-height: 2.5;

                    }

                    .mot-cloud {

                        display: inline-block;

                        margin: 5px 10px;

                        font-weight: bold;

                    }

                    .page-crawlee {

                        border-left: 5px solid #333;

                    }

                    .page-crawlee h3 {

                        margin-top: 0;

                    }

                    .page-crawlee p {

                        overflow-wrap: anywhere;

                    }

                    .table-container {

                        width: 100%;

                        overflow-x: auto;

                    }

                    table {

                        width: 100%;

                        min-width: 600px;

                        border-collapse: collapse;

                        background: white;

                    }

                    th,

                    td {

                        padding: 10px;

                        border: 1px solid #ddd;

                        text-align: left;

                    }

                    th {

                        background: #333;

                        color: white;

                    }

                    tbody tr:nth-child(even) {

                        background: #f2f2f2;

                    }

                    .retour {

                        display: inline-block;

                        margin-top: 25px;

                        text-decoration: none;

                        padding: 10px 15px;

                        background: #333;

                        color: white;

                        border-radius: 5px;

                    }

                    a:focus,

                    button:focus,

                    input:focus,

                    select:focus {

                        outline: 3px solid #777;

                        outline-offset: 2px;

                    }

                    @media (max-width: 600px) {

                        body {

                            padding: 15px;

                        }

                        h1 {

                            font-size: 26px;

                        }

                        h2 {

                            font-size: 21px;

                        }

                        .cloud {

                            padding: 15px;

                        }

                    }

                </style>

            </head>

            <body>

                <main>

                    <h1>Analyse SEO du site</h1>

                    <section

                        class="info"

                        aria-labelledby="resume-title"

                    >

                        <h2 id="resume-title">

                            Résumé

                        </h2>

                        <p>

                            <strong>Site analysé :</strong>

                            ${echapperHtml(url)}

                        </p>

                        <p>

                            <strong>Pages analysées :</strong>

                            ${resultats.length}

                        </p>

                        <p>

                            <strong>Analyse enregistrée :</strong>

                            #${analyseId}

                        </p>

                        <p>

                            <strong>Limite demandée :</strong>

                            ${limite} pages

                        </p>

                        <p>

                            <strong>Mots-clés retenus :</strong>

                            ${classementGlobal.length}

                        </p>

                    </section>

                    <section

                        class="info"

                        aria-labelledby="poids-title"

                    >

                        <h2 id="poids-title">

                            Pondération SEO utilisée

                        </h2>

                        <ul>

                            <li>Title : 10</li>

                            <li>Meta keywords : 8</li>

                            <li>Meta description : 7</li>

                            <li>H1 : 6</li>

                            <li>H2 : 5</li>

                            <li>H3 : 4</li>

                            <li>H4 : 3</li>

                            <li>H5 : 2</li>

                            <li>H6 : 1</li>

                            <li>Alt image : 1</li>

                        </ul>

                    </section>

                    <section aria-labelledby="pages-title">

                        <h2 id="pages-title">

                            Pages parcourues

                        </h2>

                        ${listePages}

                    </section>

                    <section aria-labelledby="nuage-title">

                        <h2 id="nuage-title">

                            Nuage de mots

                        </h2>

                        <div class="cloud">

                            ${nuage}

                        </div>

                    </section>

                    <section aria-labelledby="classement-title">

                        <h2 id="classement-title">

                            Classement des mots-clés

                        </h2>

                        <div class="table-container">

                            <table>

                                <thead>

                                    <tr>

                                        <th scope="col">

                                            Position

                                        </th>

                                        <th scope="col">

                                            Mot

                                        </th>

                                        <th scope="col">

                                            Fréquence

                                        </th>

                                        <th scope="col">

                                            Score SEO

                                        </th>

                                    </tr>

                                </thead>

                                <tbody>

                                    ${classementGlobal.map(

                                        ([mot, infos], index) => `

                                            <tr>

                                                <td>

                                                    ${index + 1}

                                                </td>

                                                <td>

                                                    ${echapperHtml(mot)}

                                                </td>

                                                <td>

                                                    ${infos.frequence}

                                                </td>

                                                <td>

                                                    ${infos.score}

                                                </td>

                                            </tr>

                                        `

                                    ).join("")}

                                </tbody>

                            </table>

                        </div>

                    </section>

                    <a

                        class="retour"

                        href="/"

                    >

                        Nouvelle analyse

                    </a>

                </main>

            </body>

            </html>

        `);

    } catch (error) {

        console.error("Erreur :", error.message);

        res.status(500).send(`

            <!DOCTYPE html>

            <html lang="fr">

            <head>

                <meta charset="UTF-8">

                <title>Erreur</title>

            </head>

            <body>

                <h1>Erreur</h1>

                <p>

                    ${echapperHtml(error.message)}

                </p>

                <a href="/">

                    Retour

                </a>

            </body>

            </html>

        `);

    }

});

// ============================================================

// ROUTE : /historique

// Liste toutes les analyses enregistrées dans PostgreSQL,

// de la plus récente à la plus ancienne.

// ============================================================

app.get("/historique", async (req, res) => {

    try {

        const result = await pool.query(`

            SELECT

                a.id,

                a.url,

                a.date_analyse,

                COUNT(DISTINCT p.id) AS nombre_pages,

                COUNT(DISTINCT m.id) AS nombre_mots

            FROM analyses a

            LEFT JOIN pages p

                ON p.analyse_id = a.id

            LEFT JOIN mots m

                ON m.analyse_id = a.id

            GROUP BY

                a.id,

                a.url,

                a.date_analyse

            ORDER BY

                a.date_analyse DESC

        `);

        // Transformation des lignes SQL en lignes <tr> du tableau HTML.

        const lignes = result.rows

            .map(analyse => `

                <tr>

                    <td>${analyse.id}</td>

                    <td>

                        ${echapperHtml(analyse.url)}

                    </td>

                    <td>

                        ${new Date(

                            analyse.date_analyse

                        ).toLocaleString("fr-FR")}

                    </td>

                    <td>

                        ${analyse.nombre_pages}

                    </td>

                    <td>

                        ${analyse.nombre_mots}

                    </td>

                    <td>

                        <a href="/historique/${analyse.id}">

                            Voir

                        </a>

                    </td>

                </tr>

            `)

            .join("");

        res.send(`

            <!DOCTYPE html>

            <html lang="fr">

            <head>

                <meta charset="UTF-8">

                <meta

                    name="viewport"

                    content="width=device-width, initial-scale=1.0"

                >

                <title>Historique</title>

                <style>

                    * {

                        box-sizing: border-box;

                    }

                    body {

                        font-family: Arial, sans-serif;

                        max-width: 1100px;

                        margin: auto;

                        padding: 30px;

                        background: #f4f4f4;

                        color: #222;

                    }

                    h1 {

                        text-align: center;

                    }

                    .table-container {

                        overflow-x: auto;

                    }

                    table {

                        width: 100%;

                        min-width: 700px;

                        border-collapse: collapse;

                        background: white;

                    }

                    th,

                    td {

                        padding: 10px;

                        border: 1px solid #ddd;

                        text-align: left;

                    }

                    th {

                        background: #333;

                        color: white;

                    }

                    a {

                        color: #222;

                        font-weight: bold;

                    }

                    .retour {

                        display: inline-block;

                        margin-top: 20px;

                    }

                    a:focus {

                        outline: 3px solid #777;

                        outline-offset: 2px;

                    }

                    @media (max-width: 600px) {

                        body {

                            padding: 15px;

                        }

                    }

                </style>

            </head>

            <body>

                <main>

                    <h1>Historique des analyses</h1>

                    <div class="table-container">

                        <table>

                            <thead>

                                <tr>

                                    <th scope="col">ID</th>

                                    <th scope="col">Site</th>

                                    <th scope="col">Date</th>

                                    <th scope="col">Pages</th>

                                    <th scope="col">Mots</th>

                                    <th scope="col">Détails</th>

                                </tr>

                            </thead>

                            <tbody>

                                ${lignes || `

                                    <tr>

                                        <td colspan="6">

                                            Aucune analyse enregistrée.

                                        </td>

                                    </tr>

                                `}

                            </tbody>

                        </table>

                    </div>

                    <a

                        class="retour"

                        href="/"

                    >

                        ← Retour

                    </a>

                </main>

            </body>

            </html>

        `);

    } catch (error) {

        console.error(

            "Erreur historique :",

            error.message

        );

        res.status(500).send(

            "Erreur lors du chargement de l'historique."

        );

    }

});

// ============================================================

// ROUTE : /historique/:id

// Affiche le détail d'une analyse précise grâce à son identifiant.

// ============================================================

app.get("/historique/:id", async (req, res) => {

    try {

        const analyseId =

            Number.parseInt(req.params.id, 10);

        if (

            !Number.isInteger(analyseId) ||

            analyseId <= 0

        ) {

            return res.status(400).send(

                "Identifiant invalide."

            );

        }

        // Recherche des informations générales de l'analyse.

        const analyseResult = await pool.query(

            `

            SELECT *

            FROM analyses

            WHERE id = $1

            `,

            [analyseId]

        );

        if (analyseResult.rows.length === 0) {

            return res.status(404).send(

                "Analyse introuvable."

            );

        }

        const analyse =

            analyseResult.rows[0];

        // Recherche de toutes les pages associées à cette analyse.

        const pagesResult = await pool.query(

            `

            SELECT *

            FROM pages

            WHERE analyse_id = $1

            ORDER BY id

            `,

            [analyseId]

        );

        // Recherche des mots-clés de cette analyse, classés par score.

        const motsResult = await pool.query(

            `

            SELECT *

            FROM mots

            WHERE analyse_id = $1

            ORDER BY score DESC, frequence DESC, mot ASC

            `,

            [analyseId]

        );

        // Génération de la liste HTML des pages crawlées.

        const pagesHtml = pagesResult.rows

            .map(page => `

                <li>

                    ${echapperHtml(page.url)}

                </li>

            `)

            .join("");

        // Génération du tableau HTML des mots-clés.

        const motsHtml = motsResult.rows

            .map((mot, index) => `

                <tr>

                    <td>${index + 1}</td>

                    <td>${echapperHtml(mot.mot)}</td>

                    <td>${mot.frequence}</td>

                    <td>${mot.score}</td>

                </tr>

            `)

            .join("");

        res.send(`

            <!DOCTYPE html>

            <html lang="fr">

            <head>

                <meta charset="UTF-8">

                <meta

                    name="viewport"

                    content="width=device-width, initial-scale=1.0"

                >

                <title>

                    Analyse #${analyse.id}

                </title>

                <style>

                    * {

                        box-sizing: border-box;

                    }

                    body {

                        font-family: Arial, sans-serif;

                        max-width: 1100px;

                        margin: auto;

                        padding: 30px;

                        background: #f4f4f4;

                        color: #222;

                    }

                    .bloc {

                        background: white;

                        padding: 20px;

                        margin-bottom: 25px;

                        border-radius: 10px;

                    }

                    .bloc li {

                        overflow-wrap: anywhere;

                        margin-bottom: 8px;

                    }

                    .table-container {

                        overflow-x: auto;

                    }

                    table {

                        width: 100%;

                        min-width: 600px;

                        border-collapse: collapse;

                        background: white;

                    }

                    th,

                    td {

                        padding: 10px;

                        border: 1px solid #ddd;

                        text-align: left;

                    }

                    th {

                        background: #333;

                        color: white;

                    }

                    a {

                        color: #222;

                        font-weight: bold;

                    }

                    a:focus {

                        outline: 3px solid #777;

                        outline-offset: 2px;

                    }

                    @media (max-width: 600px) {

                        body {

                            padding: 15px;

                        }

                    }

                </style>

            </head>

            <body>

                <main>

                    <h1>

                        Analyse #${analyse.id}

                    </h1>

                    <section class="bloc">

                        <p>

                            <strong>Site :</strong>

                            ${echapperHtml(analyse.url)}

                        </p>

                        <p>

                            <strong>Date :</strong>

                            ${new Date(

                                analyse.date_analyse

                            ).toLocaleString("fr-FR")}

                        </p>

                    </section>

                    <h2>Pages crawlées</h2>

                    <section class="bloc">

                        <ul>

                            ${pagesHtml || "<li>Aucune page enregistrée.</li>"}

                        </ul>

                    </section>

                    <h2>Mots-clés</h2>

                    <div class="table-container">

                        <table>

                            <thead>

                                <tr>

                                    <th scope="col">

                                        Position

                                    </th>

                                    <th scope="col">

                                        Mot

                                    </th>

                                    <th scope="col">

                                        Fréquence

                                    </th>

                                    <th scope="col">

                                        Score SEO

                                    </th>

                                </tr>

                            </thead>

                            <tbody>

                                ${motsHtml || `

                                    <tr>

                                        <td colspan="4">

                                            Aucun mot-clé enregistré.

                                        </td>

                                    </tr>

                                `}

                            </tbody>

                        </table>

                    </div>

                    <p>

                        <a href="/historique">

                            ← Retour à l'historique

                        </a>

                    </p>

                </main>

            </body>

            </html>

        `);

    } catch (error) {

        console.error(

            "Erreur détail :",

            error.message

        );

        res.status(500).send(

            "Erreur lors du chargement de l'analyse."

        );

    }

});

// ============================================================

// DÉMARRAGE DU SERVEUR

// Express écoute sur le port défini plus haut (3000 par défaut).

// ============================================================

app.listen(PORT, () => {

    console.log(

        `Serveur lancé sur http://localhost:${PORT}`

    );

});
