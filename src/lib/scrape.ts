import axios from "axios";
import * as cheerio from "cheerio";

export async function scrapePage(url: string) {
  const res = await axios.get(url);

  const $ = cheerio.load(res.data);

  const text = $("body").text();

  return text.replace(/\s+/g, " ").trim();
}