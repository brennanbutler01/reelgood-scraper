const { chromium } = require("playwright");
const fs = require("fs").promises;
const readline = require("readline");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.on('line', (input) => {
    if (input.toLowerCase() === 's') {
        global.stopRequested = true;
    } else if (input.toLowerCase() === 'v') {
        global.viewRequested = true;
    }
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

class WatchlistScraper {
    constructor() {
        this.browser = null;
        this.page = null;
        this.state = {
            titles: [],
            timestamp: new Date().toISOString(),
            expectedCount: 0,
            currentCount: 0
        };
        this.changeLog = {
            syncDate: null,
            added: [],
            removed: []
        };
        this.checkAll = false;
        this.allWebTitles = []; // Track all titles we find
        global.stopRequested = false;
        global.viewRequested = false;
    }

    async loadState() {
        try {
            const data = await fs.readFile('scraper_state.json', 'utf8');
            this.state = JSON.parse(data);
            console.log(`Loaded ${this.state.titles.length} existing titles from state file`);
            console.log(`Current count: ${this.state.currentCount}`);
            console.log(`Expected count: ${this.state.expectedCount}`);
        } catch (error) {
            console.log('No existing state file found or error reading it, starting fresh');
            this.state = {
                titles: [],
                timestamp: new Date().toISOString(),
                expectedCount: 0,
                currentCount: 0
            };
        }
    }

    async extractTitles() {
        const titles = await this.page.evaluate(() => {
            const elements = document.querySelectorAll('p:has(span[data-testid="content-listing-title"])');
            return Array.from(elements)
                .map((element) => {
                    const titleSpan = element.querySelector('span[data-testid="content-listing-title"]');
                    const title = titleSpan?.textContent?.trim() || "";
                    const fullText = element.textContent?.trim() || "";
                    let year = "";

                    if (fullText.includes("(") && fullText.includes(")")) {
                        year = fullText.substring(fullText.lastIndexOf("(") + 1, fullText.lastIndexOf(")")).trim();
                    }

                    return { title, year };
                })
                .filter(({ title, year }) => title && year);
        });

        return titles;
    }

    async updateExpectedCount() {
        try {
            const countText = await this.page.evaluate(() => {
                const elements = document.querySelectorAll('p, span, div');
                for (const el of elements) {
                    if (el.textContent?.includes('titles')) {
                        return el.textContent;
                    }
                }
                return '';
            });

            const match = countText.match(/(\d+)\s+titles/);
            if (match) {
                this.state.expectedCount = parseInt(match[1], 10);
                console.log(`Found expected count: ${this.state.expectedCount} titles`);
            }
        } catch (error) {
            console.log('Could not update expected count:', error.message);
        }
    }

    async loadAllContent() {
        console.log("\nLoading watchlist content...");
        console.log("Type 's' at any time to stop and save");
        console.log("Type 'v' to view current changes\n");
    
        await this.updateExpectedCount();
        
        const existingTitleKeys = new Set(this.state.titles.map(t => `${t.title}-${t.year}`));
        this.allWebTitles = []; // Reset the collection
        
        while (!global.stopRequested) {
            try {
                const newTitles = await this.extractTitles();
                
                // Add unique titles to our collection
                let newTitlesFound = 0;
                for (const title of newTitles) {
                    const key = `${title.title}-${title.year}`;
                    if (!this.allWebTitles.some(t => `${t.title}-${t.year}` === key)) {
                        this.allWebTitles.push(title);
                        newTitlesFound++;
                    }
                }
    
                // Handle view request if needed
                if (global.viewRequested) {
                    const added = this.allWebTitles.filter(t => !existingTitleKeys.has(`${t.title}-${t.year}`));
                    console.log('\nCurrent Changes:');
                    console.log(`New titles found so far: ${added.length}`);
                    if (added.length > 0) {
                        console.log('\nNew titles:');
                        added.forEach(t => console.log(`- ${t.title} (${t.year})`));
                    }
                    global.viewRequested = false;
                }
                
                const loadMoreButton = await this.page.waitForSelector('button:has-text("Load More")', { timeout: 20000 });
                if (!loadMoreButton) {
                    console.log('No "Load More" button found - reached the end');
                    break;
                }
    
                console.log(`Loaded ${this.allWebTitles.length} unique titles so far...`);
                if (this.state.expectedCount > 0) {
                    const percentage = ((this.allWebTitles.length / this.state.expectedCount) * 100).toFixed(1);
                    console.log(`Progress: ${percentage}% of ${this.state.expectedCount} titles`);
                }
                if (newTitlesFound === 0) {
                    console.log("No new titles found in last batch, might have reached the end");
                }
    
                await loadMoreButton.scrollIntoViewIfNeeded();
                await this.page.waitForTimeout(1000);
                await loadMoreButton.click();
                await this.page.waitForTimeout(1500);
    
            } catch (error) {
                console.log("\nError loading content. Options:");
                console.log("1. Refresh the page");
                console.log("2. Manual scroll and continue");
                console.log("3. Save and quit");
    
                const choice = await question("Choose (1-3): ");
    
                if (choice === "1") {
                    await this.page.reload();
                    await this.page.waitForLoadState("networkidle");
                } else if (choice === "2") {
                    console.log("Scroll manually, then press Enter to continue...");
                    await question("");
                } else {
                    break;
                }
            }
        }
        
        return this.allWebTitles;
    }

    async syncWithWebsite() {
        const checkAllMode = await question("\nCheck entire watchlist? (y/N): ");
        this.checkAll = checkAllMode.toLowerCase() === 'y';
        
        const webTitles = await this.loadAllContent();
        
        // Create sets for comparison using complete title+year as key
        const webTitleSet = new Set(webTitles.map(t => `${t.title}-${t.year}`));
        const localTitleSet = new Set(this.state.titles.map(t => `${t.title}-${t.year}`));
        
        // Find differences
        const added = webTitles.filter(t => !localTitleSet.has(`${t.title}-${t.year}`));
        const removed = this.checkAll ? this.state.titles.filter(t => !webTitleSet.has(`${t.title}-${t.year}`)) : [];
        
        // Log changes
        this.changeLog.syncDate = new Date().toISOString();
        this.changeLog.added = added;
        this.changeLog.removed = removed;
        
        console.log('\nSync Results:');
        console.log(`Website titles found: ${webTitles.length}`);
        console.log(`Local titles: ${this.state.titles.length}`);
        console.log(`New titles found: ${added.length}`);
        if (this.checkAll) {
            console.log(`Titles missing from website: ${removed.length}`);
        }
        
        if (added.length > 0 || removed.length > 0) {
            if (added.length > 0) {
                console.log('\nNew titles to add:');
                added.forEach(t => console.log(`- ${t.title} (${t.year})`));
            }
            if (removed.length > 0) {
                console.log('\nTitles missing from website:');
                removed.forEach(t => console.log(`- ${t.title} (${t.year})`));
            }

            const updateChoice = await question("\nUpdate local state with these changes? (Y/n): ");
            if (updateChoice.toLowerCase() !== 'n') {
                if (this.checkAll) {
                    // Full sync - replace entire state with web titles
                    this.state.titles = [...webTitles];
                } else {
                    // Partial sync - only add new titles
                    this.state.titles.push(...added);
                }
                this.state.currentCount = this.state.titles.length;
                this.state.timestamp = new Date().toISOString();
                console.log('\nLocal state updated');
            }
        } else {
            console.log('\nNo changes needed - local state is up to date!');
        }
    }

    async saveState() {
        // Ensure counts are accurate before saving
        this.state.currentCount = this.state.titles.length;
        
        // Save main state
        await fs.writeFile('scraper_state.json', JSON.stringify(this.state, null, 2), 'utf8');
        console.log(`\nSaved state with ${this.state.titles.length} total titles`);
        
        // Save CSV
        const csvContent = [
            "title,year",
            ...this.state.titles.map(({ title, year }) => `"${title.replace(/"/g, '""')}",${year}`),
        ].join("\n");
        await fs.writeFile("movies.csv", csvContent, "utf8");
        
        // Save sync log if there were changes
        if (this.changeLog.added.length > 0 || this.changeLog.removed.length > 0) {
            const logFileName = `sync_log_${this.changeLog.syncDate.split('T')[0]}.json`;
            await fs.writeFile(logFileName, JSON.stringify(this.changeLog, null, 2), 'utf8');
            console.log(`Saved sync log to ${logFileName}`);
        }

        // Print state verification
        console.log("\nState verification:");
        console.log(`Total titles: ${this.state.titles.length}`);
        console.log(`Current count: ${this.state.currentCount}`);
        console.log(`Expected count: ${this.state.expectedCount}`);
        if (this.state.expectedCount > 0) {
            const percentage = ((this.state.currentCount / this.state.expectedCount) * 100).toFixed(1);
            console.log(`Completion: ${percentage}%`);
        }
    }

    async run() {
        try {
            console.log("\nInstructions:");
            console.log("1. Close all Chrome windows first");
            console.log("2. Run this command in terminal:");
            console.log('   Mac/Linux: open -a "Google Chrome" --args --remote-debugging-port=9222');
            console.log("   Windows: start chrome.exe --remote-debugging-port=9222");
            console.log("3. Log into Reelgood manually");
            console.log("4. Navigate to https://reelgood.com/userlist/seen");

            await this.loadState();
            await question("\nPress Enter once you've completed these steps...");

            // Connect to the existing Chrome instance
            this.browser = await chromium.connectOverCDP("http://localhost:9222");
            
            // Get the first context and page
            const contexts = this.browser.contexts();
            const context = contexts[0];
            const pages = await context.pages();
            this.page = pages[0];

            // Update expected count before sync
            await this.updateExpectedCount();

            // Sync with website
            await this.syncWithWebsite();

            // Save final state
            await this.saveState();
        } catch (error) {
            console.error("An error occurred:", error);
        } finally {
            rl.close();
            if (this.browser) {
                await this.browser.close();
            }
        }
    }
}

// Run it
const scraper = new WatchlistScraper();
scraper.run();