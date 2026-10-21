import urllib.request
import urllib.robotparser
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup
import time
import json

visited_urls = set()
USER_AGENT = "MonCrawlerPedagogique/1.0"
index_data = []  # Liste pour stocker le contenu indexé

def get_robot_parser(base_url):
    parsed_url = urlparse(base_url)
    robots_url = f"{parsed_url.scheme}://{parsed_url.netloc}/robots.txt"
    
    rp = urllib.robotparser.RobotFileParser()
    rp.set_url(robots_url)
    try:
        with urllib.request.urlopen(robots_url, timeout=3) as resp:
            rp.parse(resp.read().decode('utf-8').splitlines())
        print(f"[robots.txt] Fichier chargé depuis {robots_url}")
        return rp
    except Exception as e:
        print(f"[robots.txt] Fichier introuvable ({e}). Exploration autorisée par défaut.")
        return None

def crawl(url, rp, max_depth=2, current_depth=1):
    if current_depth > max_depth or url in visited_urls:
        return

    if rp is not None and not rp.can_fetch(USER_AGENT, url):
        print(f"[{current_depth}] [BLOQUÉ par robots.txt] : {url}")
        return

    print(f"[{current_depth}] Crawling : {url}")
    visited_urls.add(url)

    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=5) as response:
            content_type = response.headers.get('Content-Type', '')
            if 'text/html' not in content_type:
                return
            
            html = response.read().decode('utf-8', errors='ignore')

        soup = BeautifulSoup(html, 'html.parser')

        # 1. Extraction des métadonnées sémantiques
        title = soup.title.string.strip() if soup.title and soup.title.string else "Pas de titre"
        h1_tags = [h1.get_text(strip=True) for h1 in soup.find_all('h1')]
        
        # 2. Ajout de la page à notre index en mémoire
        index_data.append({
            "url": url,
            "title": title,
            "h1": h1_tags,
            "depth": current_depth
        })

        # 3. Parcours des liens internes
        domain = urlparse(url).netloc
        for a_tag in soup.find_all('a', href=True):
            href = a_tag['href']
            full_url = urljoin(url, href)
            parsed_full = urlparse(full_url)

            if parsed_full.netloc == domain and parsed_full.scheme in ['http', 'https']:
                clean_url = full_url.split('#')[0]
                if clean_url not in visited_urls:
                    time.sleep(0.5)
                    crawl(clean_url, rp, max_depth, current_depth + 1)

    except Exception as e:
        print(f"   [!] Erreur sur {url} : {e}")

if __name__ == "__main__":
    start_url = "http://localhost:8080/"
    
    robot_parser = get_robot_parser(start_url)
    crawl(start_url, robot_parser, max_depth=2)

    # Sauvegarde des données dans un fichier JSON
    with open("index.json", "w", encoding="utf-8") as f:
        json.dump(index_data, f, ensure_ascii=False, indent=4)
        
    print(f"\n Indexation terminée ! {len(index_data)} pages sauvegardées dans 'index.json'.")