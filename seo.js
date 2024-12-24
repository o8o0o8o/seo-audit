const { parse } = require("node-html-parser");
const fs = require("fs");

async function crawlPages({
  pagesToCrawl,
  SEOData,
  overallErrors,
  collectedURLs,
  uniquePages,
  addMissing,
  origin,
}) {
  const BATCH_SIZE = 5; // it's better to keep it below 25
  const alternatesErrors = [];
  const uniqueTitles = new Set();
  const uniqueDescriptions = new Set();

  let isMultiLang = false;

  const META_TAGS = [
    "description",
    "keywords",
    "robots",
    "og:type",
    "og:url",
    "og:title",
    "og:description",
    "og:site_name",
    "og:image",
    "twitter:site",
    "twitter:creator",
    "twitter:title",
    "twitter:description",
    "twitter:card",
    "twitter:widgets:new-embed-design",
    "twitter:image:src",
  ];

  while (pagesToCrawl.length) {
    console.log("Pages left " + pagesToCrawl.length);

    const crawledPages = await Promise.all(
      pagesToCrawl
        .splice(0, BATCH_SIZE)
        .filter(Boolean)
        .map((url) =>
          fetch(url)
            .then(async (data) => ({
              html: await data.text(),
              url,
              status: data.status,
            }))
            .catch((error) => {
              const messageOverall = `${error.name} ${error.message} ${error.cause}`;

              overallErrors.add(messageOverall);

              const messageDetailed = `${url} ${messageOverall}`;

              SEOData.analysis.details.push(messageDetailed);

              console.log(messageDetailed);

              SEOData.pageData.totalWithError += 1;

              if (!SEOData.pageData.byError.crashed) {
                SEOData.pageData.byError.crashed = [];
                SEOData.pageData.byError.totalCrashed = 0;
              }

              SEOData.pageData.byError.crashed.push(url);
              SEOData.pageData.byError.totalCrashed += 1;
            })
        )
    );

    for (const page of crawledPages) {
      if (page) {
        const { url, html, status } = page;

        const parsedPage = parse(html);

        for (const link of parsedPage.querySelectorAll("a")) {
          const href = link.attributes.href;

          if (href?.startsWith(url)) {
            if (addMissing) {
              if (!collectedURLs.has(url)) {
                pagesToCrawl.push(url);

                collectedURLs.add(url);

                uniquePages.add(url);
              }
            } else if (!uniquePages.has(url)) {
              collectedURLs.add(url);
            }
          }
        }

        const title = parsedPage.querySelector("title")?.innerText;

        SEOData.pageData.pages[url] = {};

        const pageData = SEOData.pageData.pages[url];

        pageData.status = status;
        pageData.url = url;

        if (page.status !== 200) {
          SEOData.pageData.totalWithError += 1;

          if (!SEOData.pageData.byError[status]) {
            SEOData.pageData.byError[status] = [];
            SEOData.pageData.byError[`total${status}`] = 0;
          }

          SEOData.pageData.byError[status].push(url);
          SEOData.pageData.byError[`total${status}`] += 1;
        } else {
          SEOData.pageData.totalWithoutError += 1;
        }

        if (!title) {
          overallErrors.add(`Title is missing`);

          SEOData.analysis.details.push(
            `Title is missing for this page ${url}`
          );
        } else {
          pageData.title = title;

          if (uniqueTitles.has(title)) {
            overallErrors.add(`Some pages have identical titles`);

            SEOData.analysis.details.push(
              `Title "${title}" is duplicated for this page ${url}`
            );
          }

          uniqueTitles.add(title);
        }

        pageData.meta = [];

        for (const metaTag of parsedPage.querySelectorAll("meta")) {
          const name = metaTag.attributes.name;

          for (const tag of META_TAGS) {
            const content = metaTag.attributes.content;

            if (name === tag) {
              pageData.meta.push({ [tag]: content });

              if (name === "description" && uniqueDescriptions.has(content)) {
                overallErrors.add(`Some pages have identical descriptions`);

                SEOData.analysis.details.push(
                  `Description "${content}" is duplicated for this page ${url}`
                );
              }

              uniqueDescriptions.add(content);
            }
          }
        }

        if (pageData?.meta?.length !== META_TAGS.length) {
          overallErrors.add(`Some meta tags are missing`);

          for (const tag of META_TAGS) {
            if (
              !pageData?.meta?.some((pageMeta) =>
                Object.keys(pageMeta).some((pageTag) => pageTag === tag)
              )
            ) {
              SEOData.analysis.details.push(
                `Meta tag ${tag} is missing for this page ${url}`
              );
            }
          }
        }

        for (const link of parsedPage.querySelectorAll("link")) {
          const rel = link.attributes.rel;

          if (rel === "canonical") {
            pageData.canonical = link.attributes.href;
          }

          if (rel === "alternate") {
            isMultiLang = true;

            if (!pageData.alternates) {
              pageData.alternates = [];
            }

            pageData.alternates.push({
              hreflang: link.attributes.hrefLang,
              href: link.attributes.href,
            });
          }
        }

        if (!pageData.canonical) {
          overallErrors.add(`Canonicals are not set for some pages`);

          SEOData.analysis.details.push(
            `Canonical link is missing for this page ${url}`
          );
        }

        if (!pageData.alternates) {
          overallErrors.add(`Alternates are not set for some pages`);

          alternatesErrors.push(
            `Alternates links are missing for this page ${url}`
          );
        } else {
          for (const alternate of pageData.alternates) {
            const count = pageData.alternates.reduce((acc, cur) => {
              if (cur.href === alternate.href) {
                return (acc += 1);
              }

              return acc;
            }, 0);

            if (count > 1) {
              overallErrors.add(`Some alternates are duplicated in head links`);

              SEOData.analysis.details.push(
                `Alternate ${alternate.href} is duplicated for this page ${url}`
              );
            }
          }
        }

        const matchingCanonical =
          SEOData.sitemaps.urls[pageData.canonical] ||
          SEOData.sitemaps.urls[`${origin}pageData.canonical`];

        if (matchingCanonical) {
          if (matchingCanonical.alternates && pageData.alternates) {
            for (const pageAlternate of pageData.alternates) {
              if (matchingCanonical.alternates[pageAlternate.href]) {
              } else {
                overallErrors.add(
                  `Some alternates from sitemap don't match alternates form pages`
                );

                SEOData.analysis.details.push(
                  `Alternate ${alternate.href} has no match in sitemap for loc ${pageData.canonical} for this page ${url}`
                );
              }
            }
          }

          if (Array.isArray(pageData.alternates)) {
            for (const pageAlternate of pageData.alternates) {
              const sitemapAlternate =
                matchingCanonical.alternates[pageAlternate.href];

              if (sitemapAlternate) {
                if (sitemapAlternate.hreflang !== pageAlternate.hreflang) {
                  overallErrors.add(
                    `Some alternate hreflangs from sitemap don't match alternate hreflangs from pages`
                  );

                  SEOData.analysis.details.push(
                    `Alternate hreflangs ${alternate.hreflang} doesn't match sitemap hreflang ${sitemapAlternate.hreflang} for loc ${pageData.canonical} for this page ${url}`
                  );
                }
              } else {
                overallErrors.add(
                  `Some alternate hrefs from sitemap don't match alternates from pages`
                );

                SEOData.analysis.details.push(
                  `Alternate href ${alternate.href} has no match in sitemap for canonical ${pageData.canonical} for this page ${url}`
                );
              }
            }
          }
        } else {
          overallErrors.add(`Some loc and canonical don't match`);

          SEOData.analysis.details.push(
            `No matching loc corresponding canonical ${pageData.canonical} is found for this page ${url}`
          );
        }
      }
    }
  }

  return { alternatesErrors, isMultiLang };
}

async function seoAudit() {
  console.time("SEO analysis");

  const origin = process.argv[2].replace(/\s/g, "").replace(/\/$/, "");
  const overallErrors = new Set();

  const SEOData = {
    robots: { sitemaps: [], "user-agent": {} },
    sitemaps: { urls: {}, total: 0 },
    pageData: {
      pages: {},
      totalWithoutError: 0,
      totalWithError: 0,
      byError: {},
    },
    analysis: { overall: [], details: [] },
  };

  let sitemaps = [];

  // robots.txt analysis -------------------------------
  try {
    const robotsResponse = await fetch(origin + "/robots.txt");

    if (robotsResponse.status === 200) {
      const robots = await robotsResponse.text();

      if (robots.length) {
        let currentUserAgent = "";

        for (const str of robots.split("\n")) {
          const data = str.split(": ");
          const field = data[0].toLocaleLowerCase();
          const value = data[1];

          if (field === "sitemap") {
            SEOData.robots.sitemaps.push(value);
          }

          if (field === "user-agent") {
            currentUserAgent = value;

            if (!SEOData.robots["user-agent"][value]) {
              SEOData.robots["user-agent"][value] = { allow: [], disallow: [] };
            }
          }

          if (field === "disallow") {
            SEOData.robots["user-agent"][currentUserAgent].disallow.push(value);

            if (value === "/") {
              SEOData.analysis.details.push(
                `user-agent ${currentUserAgent} is blocked by robots.txt`
              );

              overallErrors.add(
                `Some user-agents are not allowed to crawl by robots.txt`
              );
            }
          }

          if (field === "allow") {
            SEOData.robots["user-agent"][currentUserAgent].allow.push(value);
          }
        }
      } else {
        overallErrors.add("robots.txt is empty");
      }
    } else {
      overallErrors.add("No robots.txt");
    }

    if (!SEOData.robots.sitemaps.length) {
      const message = "No sitemap in robots.txt";

      overallErrors.add(message);

      const sitemapUrl = origin + "/sitemap.xml";

      console.log(message + " fallback to default sitemap url " + sitemapUrl);

      SEOData.sitemaps = { [sitemapUrl]: {} };

      sitemaps.push(sitemapUrl);
    } else {
      sitemaps = [...SEOData.robots.sitemaps];
    }

    for (const [key, value] of Object.entries(SEOData.robots["user-agent"])) {
      if (!value.allow.length && !value.disallow.length) {
        SEOData.analysis.details.push(
          `Empty ruleset for user-agent ${key} in robots.txt`
        );

        overallErrors.add(`Some user-agents have no rules in robots.txt`);
      }
    }
  } catch (error) {
    const message = `Error during processing robots.txt ${error.name} ${error.message} ${error.cause}`;

    overallErrors.add(message);

    console.log(message);
  }

  // sitemaps analysis -------------------------------
  for (const sitemapUrl of sitemaps) {
    try {
      const sitemapResponse = await fetch(sitemapUrl);
      const sitemap = await sitemapResponse.text();
      const parsedSitemap = parse(sitemap);
      const unique = new Set();
      const processedUrls = {};
      const urls = parsedSitemap.querySelectorAll("url");

      if (urls.length) {
        getURLsFromSitemap({
          urls,
          unique,
          processedUrls,
          overallErrors,
          SEOData,
          currentSitemap: sitemapUrl,
          origin,
        });
      } else {
        for (const sitemap of parsedSitemap.querySelectorAll("sitemap")) {
          const sitemapPage = sitemap.querySelector("loc")?.innerText;
          const sitemapPageResponse = await fetch(sitemapPage);
          const sitemapPageText = await sitemapPageResponse.text();
          const parsedSitemapPage = parse(sitemapPageText);

          getURLsFromSitemap({
            urls: parsedSitemapPage.querySelectorAll("url"),
            unique,
            processedUrls,
            overallErrors,
            SEOData,
            currentSitemap: sitemapPage,
            origin,
          });
        }
      }
    } catch (error) {
      const message = `Error during processing sitemap ${sitemapUrl} ${error.name} ${error.message} ${error.cause}`;

      overallErrors.add(message);

      console.log(message);
    }
  }

  // pages analysis -------------------------------
  const uniquePages = new Set(Object.keys(SEOData.sitemaps.urls));
  const collectedURLs = new Set();
  const pagesToCrawl = Array.from(uniquePages);

  console.log("Crawling pages from sitemap...");

  const crawledData = await crawlPages({
    pagesToCrawl,
    SEOData,
    overallErrors,
    collectedURLs,
    uniquePages,
    origin,
  });

  let alternatesErrors = crawledData.alternatesErrors;
  let isMultiLang = crawledData.isMultiLang;

  if (collectedURLs.size) {
    overallErrors.add(`Some URLs are not listed in sitemap`);

    console.log("Crawling pages that are missing in sitemap...");

    const pagesToCrawl = Array.from(collectedURLs);

    const crawledData = await crawlPages({
      pagesToCrawl,
      SEOData,
      overallErrors,
      collectedURLs,
      uniquePages,
      addMissing: true,
      origin,
    });

    alternatesErrors = crawledData.alternatesErrors;
    isMultiLang = crawledData.isMultiLang;
  }

  if (isMultiLang && alternatesErrors.length) {
    overallErrors.add(`Alternates are not set for some pages`);

    SEOData.analysis.details = [
      ...SEOData.analysis.details,
      ...alternatesErrors,
    ];
  }

  SEOData.pageData.total = uniquePages.size;
  SEOData.analysis.overall = Array.from(overallErrors);
  SEOData.pageData.isMultiLang = isMultiLang;

  console.timeEnd("SEO analysis");

  const domainName = origin.replace("https://", "");

  fs.writeFileSync(`SEOAnalysis__${domainName}.json`, JSON.stringify(SEOData));
}

seoAudit();

function getURLsFromSitemap({
  urls,
  unique,
  processedUrls,
  overallErrors,
  SEOData,
  currentSitemap,
  origin,
}) {
  for (const site of urls) {
    const processedData = {
      loc: site.querySelector("loc")?.innerText,
      lastmod: site.querySelector("lastmod")?.innerText,
      changefreq: site.querySelector("changefreq")?.innerText,
      priority: site.querySelector("priority")?.innerText,
      alternates: {},
    };

    unique.add(processedData.loc);

    for (const alternate of site.querySelectorAll("xhtml:link")) {
      if (alternate.attributes.rel === "alternate") {
        processedData.alternates[alternate.attributes.href] = {
          hreflang: alternate.attributes.hreflang,
          href: alternate.attributes.href,
        };
      }
    }

    processedUrls[processedData.loc] = processedData;
  }
  const locs = Object.keys(processedUrls);

  if (locs.length >= 50000) {
    overallErrors.add("Sitemap is reached the limit 50000 " + currentSitemap);
  }

  if (unique.size !== locs.length) {
    overallErrors.add("There are duplications in sitemap " + currentSitemap);

    for (const site of locs) {
      const count = locs.reduce((acc, curr) => {
        if (curr === site) {
          return acc + 1;
        }
        return acc;
      }, 0);

      if (count > 1) {
        SEOData.analysis.details.push(
          `Duplicate url: ${key} in sitemap: ${currentSitemap}`
        );
      }
    }
  }

  const withTrailingSlash = [];
  const withoutTrailingLSlash = [];

  for (const site of unique) {
    if (!site.startsWith(origin)) {
      overallErrors.add(
        `Incorrect origin ${site} in sitemap ${currentSitemap}`
      );
    }

    if (site.endsWith("/")) {
      withTrailingSlash.push(site);
    } else {
      withoutTrailingLSlash.push(site);
    }
  }

  if (withTrailingSlash.length && withoutTrailingLSlash.length) {
    overallErrors.add(
      `Trailing slash inconsistencies in sitemap ${currentSitemap}: withTrailingSlash = ${withTrailingSlash.length}, withoutTrailingLSlash = ${withoutTrailingLSlash.length}`
    );
  }

  SEOData.sitemaps[currentSitemap] = {
    total: locs.length,
    totalUnique: unique.size,
    urls: processedUrls,
  };

  SEOData.sitemaps.urls = { ...SEOData.sitemaps.urls, ...processedUrls };
  SEOData.sitemaps.total += locs.length;
}
