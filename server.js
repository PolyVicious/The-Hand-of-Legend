require('dotenv').config(); // Add this line to load environment variables from a .env file

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const path = require("path");
const moment = require("moment-timezone");
const WebSocket = require("ws");
const crypto = require('crypto');
const fs = require('fs');
const Ajv = require("ajv"); // Add this line to require Ajv
const ajv = new Ajv(); // Add this line to create an instance of Ajv
const lockfile = require('proper-lockfile'); // Add this line to require proper-lockfile
const http = require('http'); // Add this line to require the http module

const app = express();
app.use(bodyParser.json());
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "assets")));
app.set("views", __dirname);

const BLOCKCYPHER_API_URL = "https://api.blockcypher.com/v1/bcy/test";
const BLOCKCYPHER_TOKEN = "c51fb87218c24dd3bd8b3104ff9dae4c"; 
const HOST_WALLET_ADDRESS = "BwjJSn5r8fQRk65EycP6nniM2ccEcrmiGY"; 
const TICKET_PRICE = 10000; 
const TOTAL_TICKETS = 10; // Define the total number of tickets available
let tickets = {};
let lastWinner = null; // Store the last winner
let winners = [];

// Load winners from winners.json
if (fs.existsSync('winners.json')) {
    const data = fs.readFileSync('winners.json', 'utf8');
    if (data) {
        try {
            winners = JSON.parse(data);
            if (!Array.isArray(winners)) {
                winners = [];
            }
        } catch (error) {
            console.error("Error parsing winners.json:", error);
            winners = [];
        }
    }
}

// Get the exact timestamp for next Sunday at 23:59:59 UTC
function getNextSundayEnd() {
    const now = moment().utc();
    let nextSunday = now.clone().startOf("isoWeek").add(7, "days").set({
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 999,
    });

    // If today is Sunday, set the end time to today at 23:59:59 UTC
    if (now.isoWeekday() === 7) {
        nextSunday = now.clone().set({
            hour: 23,
            minute: 59,
            second: 59,
            millisecond: 999,
        });
    }

    return nextSunday.valueOf();
}

let lotteryEnd = getNextSundayEnd();

function getRemainingTime() {
    const now = moment().utc().valueOf();
    const remainingTime = lotteryEnd - now;
    return {
        days: Math.floor(remainingTime / (1000 * 60 * 60 * 24)),
        hours: Math.floor((remainingTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((remainingTime % (1000 * 60)) / 1000),
    };
}

const TIMESTAMP_FILE = 'timestamp.json';
const WINNERS_FILE = 'winners.json';
const WALLETS_FILE = 'wallets.json';

const fsPromises = require('fs').promises;

async function ensureFileExists(filePath) {
    try {
        await fsPromises.access(filePath);
    } catch (error) {
        await fsPromises.writeFile(filePath, JSON.stringify({}));
    }
}

// Ensure all necessary files exist at startup
(async () => {
    await ensureFileExists(WINNERS_FILE);
    await ensureFileExists(TIMESTAMP_FILE);
    await ensureFileExists(WALLETS_FILE);
})();

async function saveTimestamp(timestamp) {
    try {
        await fsPromises.writeFile(TIMESTAMP_FILE, JSON.stringify({ lastProcessedTimestamp: timestamp }, null, 2));
    } catch (error) {
        console.error("Error saving timestamp:", error);
    }
}

async function loadTimestamp() {
    try {
        await fsPromises.access(TIMESTAMP_FILE);
        const data = await fsPromises.readFile(TIMESTAMP_FILE, 'utf8');
        if (data && data.trim().length > 0) {
            return JSON.parse(data).lastProcessedTimestamp;
        } else {
            const currentTime = Date.now();
            await saveTimestamp(currentTime);
            return currentTime;
        }
    } catch (error) {
        console.error("Error loading timestamp:", error);
    }
    return null;
}

async function saveWinners(winners) {
    try {
        await fsPromises.writeFile(WINNERS_FILE, JSON.stringify(winners, null, 2));
    } catch (error) {
        console.error("Error saving winners:", error);
    }
}

async function loadTickets() {
    await ensureFileExists(WALLETS_FILE);
    const data = await fsPromises.readFile(WALLETS_FILE, 'utf8');
    return data ? JSON.parse(data) : {};
}

async function saveTickets(tickets) {
    try {
        await fsPromises.writeFile(WALLETS_FILE, JSON.stringify(tickets, null, 2));
    } catch (error) {
        console.error("Error saving tickets:", error);
    }
}

// Update processTickets function to use the timestamp from the file
async function processTickets() {
    try {
        await ensureFileExists(WALLETS_FILE); // Ensure the file exists before locking it

        const isLocked = await lockfile.check(WALLETS_FILE);
        if (isLocked) {
            console.warn("Lock file is already being held");
            return;
        }
        await lockfile.lock(WALLETS_FILE);
        
        tickets = await loadTickets();

        const response = await axios.get(`${BLOCKCYPHER_API_URL}/addrs/${HOST_WALLET_ADDRESS}/full?token=${BLOCKCYPHER_TOKEN}`);
        const transactions = response.data.txs;

        let lastProcessedTimestamp = await loadTimestamp();
        if (!lastProcessedTimestamp) {
            lastProcessedTimestamp = Date.now();
            await saveTimestamp(lastProcessedTimestamp);
        }

        const newTransactions = transactions.filter(tx => new Date(tx.received).getTime() > lastProcessedTimestamp);

        newTransactions.forEach(tx => {
            const txTimestamp = new Date(tx.received).getTime();
            const confirmations = tx.confirmations;

            if (confirmations >= 0) {
                tx.outputs.forEach(output => {
                    if (output.addresses.includes(HOST_WALLET_ADDRESS)) {
                        const ticketCount = Math.floor(output.value / TICKET_PRICE);
                        if (ticketCount > 0) {
                            const buyerAddress = tx.inputs[0].addresses[0];
                            tickets[buyerAddress] = (tickets[buyerAddress] || 0) + ticketCount;                          
                        }
                    }
                });
                lastProcessedTimestamp = txTimestamp;
            }
        });

        const totalTicketsSold = Object.values(tickets).reduce((a, b) => a + b, 0);
        const remainingTickets = Math.max(0, TOTAL_TICKETS - totalTicketsSold);

        if (totalTicketsSold >= TOTAL_TICKETS) {
            const winner = pickWinner();
            lastWinner = { address: winner, timestamp: new Date().toISOString() };
            tickets = {};
            await saveTimestamp(lastProcessedTimestamp);
            winners.unshift(lastWinner);
            winners = winners.slice(0, 10); // Keep only the last 10 winners
            await saveWinners(winners);
        } else {
            await saveTimestamp(lastProcessedTimestamp);
        }

        await saveTickets(tickets);
        broadcastTickets(remainingTickets);
        await lockfile.unlock(WALLETS_FILE);
    } catch (error) {
        console.error("Error processing tickets:", error.message, error.stack);
        try {
            await lockfile.unlock(WALLETS_FILE);
        } catch (unlockError) {
            console.error("Error unlocking wallets.json:", unlockError.message, unlockError.stack);
        }
    }
}

function pickWinner() {
    let totalTickets = Object.values(tickets).reduce((a, b) => a + b, 0);
    let randomPick = crypto.randomInt(totalTickets); // Use crypto.randomInt for secure random number
    let cumulative = 0;

    for (let address in tickets) {
        cumulative += tickets[address];
        if (randomPick < cumulative) {
            return address;
        }
    }
    return null;
}

function broadcastTickets(remainingTickets) {
    const data = JSON.stringify({remainingTickets: Math.max(0, remainingTickets), tickets });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

const ticketSchema = { // Add this line to define the ticket schema
    type: "object",
    patternProperties: {
        "^[a-zA-Z0-9]+$": { type: "integer", minimum: 0 }
    },
    additionalProperties: false
};

function validateTickets(data) { // Add this function to validate tickets
    const validate = ajv.compile(ticketSchema);
    if (!validate(data)) {
        console.error("Invalid tickets data:", validate.errors);
        return false;
    }
    return true;
}

app.get("/", (req, res) => {
    res.redirect("/Index");
});

app.get("/Index", async (req, res) => {
    tickets = await loadTickets();
    const ticketsSold = Object.values(tickets).reduce((a, b) => a + b, 0);
    const remainingTickets = Math.max(0, TOTAL_TICKETS - ticketsSold); // Ensure remainingTickets is non-negative
    const hostWalletAddress = HOST_WALLET_ADDRESS;
    const latestWinner = winners.length > 0 ? winners[0] : null; // Get the latest winner

    res.render("Index", {
        remainingTickets,
        hostWalletAddress,
        tickets,
        lastWinner: latestWinner, // Pass the latest winner to the template
        winners // Pass the winners list to the template
    });
});

app.get("/wallets", async (req, res) => {
    tickets = await loadTickets();
    res.render("wallets", { tickets });
});

app.post("/Index/draw", async (req, res) => {
    if (Date.now() < lotteryEnd) {
        return res.json({ message: "Lottery is still running" });
    }

    const winner = pickWinner();
    if (winner) {
        lastWinner = { address: winner}; // Store the last winner
        res.render("winner", { winner});
    } else {
        res.json({ message: "No winner selected." });
    }

    lotteryEnd = getNextSundayEnd();
    tickets = {};
});

// Check for received tokens every 100 seconds
setInterval(async () => {
    await processTickets();
}, 100000);

const server = http.createServer(app); // Create an HTTP server using the Express app

const wss = new WebSocket.Server({ server }); // Use the HTTP server with the WebSocket server

wss.on("connection", ws => {
    const sendRemainingTime = () => {
        ws.send(JSON.stringify(getRemainingTime()));
    };
    sendRemainingTime();
    const interval = setInterval(sendRemainingTime, 1000);
    ws.on("close", () => clearInterval(interval));
});

const PORT = process.env.PORT || 3000; // Define the port
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

