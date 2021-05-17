/* Node Binance Trader
https://bitcoinvsaltcoins.com/

------------------------------------------------
NEW VERSION by iyenal - v90
------------------------------------------------

Features:

- Dynamic auto-balance for margin trades
- Remote DB to save states if shortages etc
- Independent qty for short/long (spot on its way)
- Tracking transactions success
- Transactions/balance emulator for testing
- Updating balance qty from Binance (still lacks tests, waiting that NPM lib gets updated)
- Wrapped buy/sell processes into Promises
- Fallback on spot and independent auto-balance for it

Like the features?
Feel free to donate BNB on 0x74da82bdafa31baf6814b7d322a46a781c80626b (BEP20(BSC))

----

AND VERY IMPORTANT, DONATE TOO TO THE ORIGINAL CREATOR!
He's doing a great job at creating strategies and sharing signals, and this script wouldn't even exist without him.

Patreon: https://www.patreon.com/bitcoinvsaltcoins
BNB: 0xf0c499c0accddd52d2f96d8afb6778be0659ee0c

Special thanks to herve76 for making all what is behind BVA, and zen for teaching me first how it works :)

------------------------------------------------

Before to use the script, I advise you to read it and understand how it works so you can be sure by yourself.
And reminder that it comes without any warranty.


SETUP GUIDE:

1) In BOT PROPERTIES, fill your keys and infos:

KEYS:
APIKEY, APISECRET (Binance) and BVA_API_KEY for your BVA key
Note that trades will incorrectly be shown in BvA dashboard, only the local DB is a correct reference.

DATA:

Autobalance LONG:
	- balance_long for your MARGIN total balance (in BTC)
	- balance_spot for your SPOT total balance (in BTC)
	- minDiv for minimal total balance splitting (eg. 3 to use only 1/3 of total balance if there're less than 3 trades going on)
	
- balance_short for amount of BTC to use on SHORT trades (in BTC)


2) Setup your MongoDB Database

MongoDB is used to keep track of what has been splitted so far, as it can be updated everytime.
We'll use MongoDB Atlas as its free plan has more than enough for our needs, and offers a pretty great dashboard to monitor/edit remotely our local DB.

- Create an Atlas account:
	https://docs.atlas.mongodb.com/tutorial/create-atlas-account/
	
- Create a cluster (keep the name for the configuration):
	https://docs.atlas.mongodb.com/tutorial/deploy-free-tier-cluster/
  and allow everyone (any IP) to access your DB:
	https://docs.atlas.mongodb.com/security/add-ip-address-to-list/
	
- And now the last part, click "Connect" in the cluster panel, select "My own application using official drivers" and "Node.js"

	Replace <password> and "myFirstDatabase" empty (just .mongodb.net/?retryWrites=true&w=majority)
	To then insert it in the script, you should end with this form:

	const uri = "mongodb+srv:// <username> : <password> @ <cluster name> .rwwmy.mongodb.net/?retryWrites=true&w=majority";

It may look long, but it's pretty simple and straightforward at end.
If the config is correct, the script should list the existing collections in your cluster (or nothing if it's empty). Otherwise expect a crash unfortunately.

3) Make init_db true, for the first run as it'll create the necessary data for the following runs.
Then stop the script, and keep it false to restart the script and let it do the work.

--- Disabling MongoDB: it should just work by commenting openDatabase, downloadData and uploadData functions body.

DONE!

*/

//{ BOT PROPERTIES

// NPM libs
const express = require("express")
const io = require("socket.io-client")
const _ = require("lodash")
const colors = require("colors")
const BigNumber = require("bignumber.js")
const axios = require("axios")
const Binance = require("node-binance-api")
const nodemailer = require("nodemailer")
const MongoClient = require("mongodb").MongoClient
const { IncomingWebhook } = require("@slack/webhook")
const env = require("./env")

const slack_url = env.SLACK_WEBHOOK_URL

//////////////////////////////////////////////////////////////////////////////////
const uri = `mongodb://${env.MONGO_INITDB_ROOT_USERNAME}:${env.MONGO_INITDB_ROOT_PASSWORD}@localhost/?retryWrites=true&w=majority`
const app = express()

//////////////////////////////////////////////////////////////////////////////////

let trading_pairs = {}
let open_trades = {}
let trading_types = {}
let trading_qty = {}
let buy_prices = {}
let sell_prices = {}
var user_payload = []
let minimums = {}

//////////////////////////////////////////////////////////////////////////////////

const send_email = false // USE SEND MAIL ---- true = YES; false = NO
const gmail_address = "no_mail"
const gmail_app_password = "no_password"
const gmailEmail = encodeURIComponent(gmail_address)
const gmailPassword = encodeURIComponent(gmail_app_password)

// Configuration for LONG trades
const balance_long = env.BALANCE_LONG // BTC balance on MARGIN
const balance_spot = env.BALANCE_SPOT // BTC balance on SPOT
const minDiv = 2 // minimum balance splitting
const minDivShort = 2 // minimum balance splitting

// Configuration for SHORT trades
const balance_short = env.BALANCE_SHORT // BTC/trade

// Testnet
const bnb_client = new Binance().options({
    //real trade
    APIKEY: env.BINANCE_API_KEY,
    APISECRET: env.BINANCE_SECRET_KEY,
})

//////////////////////////////////////////////////////////////////////////////////

// BVA Key
const BVA_API_KEY = env.BVA_API_KEY
const nbt_vers = "0.2.4"
const socket = io("https://nbt-hub.herokuapp.com", {
    query: "v=" + nbt_vers + "&type=client&key=" + BVA_API_KEY,
})

// Script related config
var test_trades = false

// Make it true to initialize your database, but only it for the first run (halt when done, change it to false and restart)
var init_db = false
var db

if (slack_url !== "") {
    var webhook = new IncomingWebhook(slack_url)

    ;(async () => {
        await webhook.send({
            text: "Bot started \n",
        })
    })()
}

//}

// Initialize connection once
MongoClient.connect(
    uri,
    { useNewUrlParser: true, useUnifiedTopology: true },
    (err, database) => {
        if (err) throw err

        db = database

        app.listen(process.env.PORT || 8003, () =>
            console.log("NBT auto trader running. NEW VERSION".grey)
        )
    }
)

app.get("/", (req, res) => res.send(""))

//{ BASIC SERVER IO

socket.on("connect", () => {
    console.log("Auto Trader connected.".grey)
})

socket.on("disconnect", () => {
    console.log("Auto Trader disconnected.".grey)
})

socket.on("message", (message) => {
    console.log(colors.magenta("NBT Message: " + message))
})

socket.on("stop_traded_signal", async (signal) => {
    console.log(
        colors.grey(
            "NBT HUB =====> stop_traded_signal",
            signal.stratid,
            signal.pair,
            signal.trading_type
        )
    )
    const tresult = _.findIndex(user_payload, (o) => {
        return o.stratid == signal.stratid
    })
    if (tresult > -1) {
        if (open_trades[signal.pair + signal.stratid]) {
            delete open_trades[signal.pair + signal.stratid]
        }
    }
})

//}

//{ USER TRIGGERED

socket.on("close_traded_signal", async (signal) => {
    console.log(
        colors.grey(
            "NBT HUB =====> close_traded_signal",
            signal.stratid,
            signal.pair,
            signal.trading_type
        )
    )
    const tresult = _.findIndex(user_payload, (o) => {
        return o.stratid == signal.stratid
    })

    if (tresult > -1) {
        if (trading_types[signal.pair + signal.stratid] === "LONG") {
            managerTrade(
                -1,
                signal.pair,
                signal.price,
                signal.score,
                signal.stratname,
                signal.stratid
            )
        } else if (trading_types[signal.pair + signal.stratid] === "SHORT") {
            console.log(
                colors.grey(
                    "CLOSE_SIGNAL :: BUY TO COVER SHORT TRADE ::",
                    signal.stratname,
                    signal.stratid,
                    signal.pair
                )
            )
            //////
            const traded_buy_signal = {
                key: BVA_API_KEY,
                stratname: signal.stratname,
                stratid: signal.stratid,
                trading_type: user_payload[tresult].trading_type,
                pair: signal.pair,
                qty: signal.qty,
            }
            socket.emit("traded_buy_signal", traded_buy_signal)
            //////
            if (user_payload[tresult].trading_type === "real") {
                console.log(signal.pair, " ---==---> BUY ", signal.qty)
                if (signal.pair == "BTCUSDT") {
                    bnb_client.mgMarketBuy(
                        "BTCUSDT",
                        signal.qty,
                        (error, response) => {
                            if (error)
                                console.log(
                                    "ERROR 990099 BTCUSDT",
                                    Number(signal.qty),
                                    error.body
                                )
                            if (response) {
                                console.log("----- mgRepay BTC -----")
                                bnb_client.mgRepay(
                                    "BTC",
                                    Number(signal.qty),
                                    (error, response) => {
                                        if (error)
                                            console.log(
                                                "ERROR BTC 9",
                                                Number(signal.qty),
                                                error.body
                                            )
                                        else console.log("SUCCESS BTC 8")
                                    }
                                )
                            }
                        }
                    )
                } else {
                    const alt = signal.pair.replace("BTC", "")
                    if (minimums[alt + "BTC"].minQty) {
                        const qty = trading_qty[signal.pair + signal.stratid]
                        console.log("QTY ==> " + qty + " - " + alt + "BTC")
                        bnb_client.mgMarketBuy(
                            alt + "BTC",
                            Number(qty),
                            (error, response) => {
                                if (error) {
                                    console.log(
                                        "ERROR 2 ",
                                        alt,
                                        Number(
                                            user_payload[tresult].buy_amount
                                        ),
                                        error.body
                                    )
                                }
                                if (response) {
                                    console.log("----- mgRepay -----")
                                    bnb_client.mgRepay(
                                        alt,
                                        Number(qty),
                                        (error, response) => {
                                            if (error)
                                                console.log(
                                                    "ERROR 99999999999",
                                                    alt,
                                                    Number(qty),
                                                    error.body
                                                )
                                            else
                                                console.log(
                                                    "SUCCESS 888888888888"
                                                )
                                        }
                                    )
                                }
                            }
                        )
                    } else {
                        console.log("PAIR UNKNOWN", alt)
                    }
                }
            }
            //////
            delete trading_pairs[signal.pair + signal.stratid]
            delete trading_types[signal.pair + signal.stratid]
            delete buy_prices[signal.pair + signal.stratid]
            delete trading_qty[signal.pair + signal.stratid]
            delete open_trades[signal.pair + signal.stratid]
            //////
        }
    }
})

socket.on("user_payload", async (data) => {
    // SEND TRADE EMAIL
    if (send_email) {
        const mailOptions = {
            from: '" BVA " <no-reply@dot.com>',
            to: gmail_address,
            subject: "BVA",
            text: "BVA Bot Payload \n",
        }
        mailTransport
            .sendMail(mailOptions)
            .then(() => {})
            .catch((error) => {
                console.error(
                    "There was an error while sending the email ... trying again..."
                )
                setTimeout(() => {
                    mailTransport
                        .sendMail(mailOptions)
                        .then(() => {})
                        .catch((error) => {
                            console.error(
                                "There was an error while sending the email: stop trying"
                            )
                        })
                }, 2000)
            })
    }

    if (slack_url !== "") {
        $parsed = JSON.stringify(data)
        await webhook.send({
            text: `BVA Bot Payload \n ${$parsed}`,
        })
    }

    console.log(
        colors.grey("NBT HUB => user strategies + trading setup updated V4")
    )
    user_payload = data
    await saveUserPayload(data)
})

//}

//{ MANAGEMENT

/*---------------------------------------------------
                   Documentation:
-----------------------------------------------------

var signal.stratname : stratname
-> strategy name
var signal.pair : pair
-> pair traded
var signal.price : price
-> price of trade
var signal.stratid : stratid

(tresult : column of user_payload for strategy config)

---------------------------------------------------*/

//{ TRADE EMULATOR

var emulatePairs = [
    "BNBBTC",
    "NEOBTC",
    "XRPBTC",
    "ZRXBTC",
    "ADABTC",
    "TOMOBTC",
    "XTZBTC",
    "RENBTC",
]
var emulateBalance = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]
var emulatePrice = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]
var emulateFee = 0

function emulateBuy(type, qty, price) {
    emulatePairs.forEach(function (item, index, array) {
        if (type.localeCompare(emulatePairs[index]) == 0) {
            console.log(
                "Emulation: bought for " + qty + " of " + emulatePairs[index]
            )
            emulatePrice[index] = price
            emulateBalance[index] += qty

            // Calculating fees
            emulateFee +=
                emulateBalance[index] * emulatePrice[index] * (0.075 / 100)
        }
    })
}

function emulateSell(type, qty) {
    emulatePairs.forEach(function (item, index, array) {
        if (type.localeCompare(emulatePairs[index]) == 0) {
            console.log(
                "Emulation: sold for " + qty + " of " + emulatePairs[index]
            )
            emulateBalance[index] -= qty

            // Calculating fees
            emulateFee += qty * emulatePrice[index] * (0.075 / 100)
        }
    })
}

function showBalance(type, qty) {
    console.log("")
    console.log("SHOW BALANCE :")
    console.log("--------------------------------------")

    var totalCalc = 0

    emulatePairs.forEach(function (item, index, array) {
        totalCalc += emulateBalance[index] * emulatePrice[index]
    })

    emulatePairs.forEach(function (item, index, array) {
        btcEstimate = emulateBalance[index] * emulatePrice[index]
        console.log(
            emulatePairs[index] +
                " balance_long: " +
                emulateBalance[index] +
                " (" +
                btcEstimate +
                " BTC, " +
                (btcEstimate / balance_long) * 100 +
                "%)"
        )
    })

    console.log("")
    console.log("TOTAL BALANCE: " + totalCalc + " BTC used on " + balance_long)
    console.log(
        "Estimated fee: " + emulateFee + " BTC ( ~" + emulateFee * 35000 + "€ )"
    )
    console.log("--------------------------------------")
    console.log("")
}

//}

// Margin Arrays
var longTradesPairs = new Array(0)
var longTradesPrices = new Array(0)
var longTradesQuantities = new Array(0)

// Spot Arrays
var longTradesSpotPairs = new Array(0)
var longTradesSpotPrices = new Array(0)
var longTradesSpotQuantities = new Array(0)

var margin_pairs = new Array(0)

// WARNING: Only internal use
async function managerSpotTrade(
    action,
    pair,
    price,
    score,
    stratname,
    stratid
) {
    openSpotTrades = longTradesSpotPairs.length

    console.log(
        colors.blue(
            "TRADE SPOT MANAGER OK, managing " +
                openSpotTrades +
                " long spot trades."
        )
    )

    var boughtQty = 0

    // Calibration needed
    if (!(openSpotTrades < minDivShort)) {
        console.log("Rebalancing...")

        newQty = balance_spot / (openSpotTrades + 1)

        // Save the entry
        var addPair = longTradesSpotPairs.push(pair)
        var addPrice = longTradesSpotPrices.push(price)
        var addQty = longTradesSpotQuantities.push(0)

        //Recalibrate the rest
        for (index = 0; index < longTradesSpotPairs.length; index++) {
            console.log(
                colors.red(
                    "RECALIBRATING " +
                        longTradesSpotPairs.length +
                        " long trades."
                )
            )

            var pairQueue = longTradesSpotPairs[index]
            var priceQueue = longTradesSpotPrices[index]
            var oldQty = longTradesSpotQuantities[index]

            //Convert oldQty to BTC

            if (oldQty - newQty < 0) {
                console.log(
                    "(calibration) BUY " +
                        pairQueue +
                        " " +
                        (newQty - oldQty) +
                        " BTC"
                )
                // before qty is less than new qty -> have to buy difference
                const qtyOK = await buySpotWrapper(
                    newQty - oldQty,
                    pairQueue,
                    priceQueue,
                    score,
                    stratname,
                    stratid
                )

                longTradesSpotQuantities[index] = oldQty + qtyOK

                console.log(
                    "(calibration) BTC bought " +
                        qtyOK +
                        ", now " +
                        longTradesSpotQuantities[index] +
                        ", was " +
                        oldQty
                )
            } else {
                console.log(
                    "(calibration) SELL " + pairQueue + " " + (oldQty - newQty)
                )
                // before qty is more than new qty -> have to sell difference
                const qtyOK = await sellWrapper(
                    oldQty - newQty,
                    pairQueue,
                    priceQueue,
                    score,
                    stratname,
                    stratid
                )

                longTradesSpotQuantities[index] = oldQty - qtyOK

                console.log(
                    "(calibration) BTC sold " +
                        qtyOK +
                        ", now " +
                        longTradesSpotQuantities[index] +
                        ", was " +
                        oldQty
                )
            }

            //If failed trasnsaction or balance_long now empty for some reason, remove it
            if (longTradesSpotQuantities[index] == 0) {
                //Update the trades array
                var removePair = longTradesSpotPairs.splice(index, 1)
                var removePrice = longTradesSpotPrices.splice(index, 1)
                var removeQty = longTradesSpotQuantities.splice(index, 1)
            }

            console.log("---")
        }
    } else if (openSpotTrades < minDivShort) {
        quantity = balance_spot / minDivShort

        //Try to buy on spot
        qtyOK = await buySpotWrapper(
            quantity,
            pair,
            price,
            score,
            stratname,
            stratid
        )

        if (qtyOK != 0) {
            //Update the trades array
            var addQty = longTradesSpotQuantities.push(qtyOK)
            var addPair = longTradesSpotPairs.push(pair)
            var addPrice = longTradesSpotPrices.push(price)
        }
    }
}

async function managerTrade(action, pair, price, score, stratname, stratid) {
    openTrades = longTradesPairs.length
    openSpotTrades = longTradesSpotPairs.length

    console.log(
        colors.blue(
            "TRADE MANAGER OK, managing " +
                openTrades +
                " long trades, " +
                openSpotTrades +
                " on Spot"
        )
    )

    if (action == 1) {
        console.log(
            "=== BUY_SIGNAL === ENTER LONG TRADE ====",
            stratname,
            stratid,
            pair
        )
    } else {
        console.log(
            "=== SELL_SIGNAL === EXIT LONG TRADE ====",
            stratname,
            stratid,
            pair
        )
    }

    // OPEN action
    if (
        action == 1 &&
        !(longTradesPairs.indexOf(pair) >= 0) &&
        !(longTradesSpotPairs.indexOf(pair) >= 0)
    ) {
        /*
		trading_pairs[pair+stratid] = true
		trading_types[pair+stratid] = "LONG"
		open_trades[pair+stratid] = true
		trading_qty[pair+stratid] = Number(quantity)
		
		////
		const traded_buy_signal = {
			key: BVA_API_KEY,
			stratname: stratname,
			stratid: stratid,
			trading_type: "real",
			pair: pair, 
			qty: Number(quantity)
		}
		socket.emit("traded_buy_signal", traded_buy_signal)
		////
		*/
        // TODO: Register buy info in arrays

        if (openTrades < minDiv) {
            //Quantity in BTC
            var quantity = balance_long / minDiv

            const qtyOK = await buyWrapper(
                quantity,
                pair,
                price,
                score,
                stratname,
                stratid
            )

            // use the return value here instead of like a regular (non-evented) return value

            console.log("--- BOUGHT: " + qtyOK)

            if (qtyOK != 0) {
                //Update the trades array
                var addQty = longTradesQuantities.push(qtyOK)
                var addPair = longTradesPairs.push(pair)
                var addPrice = longTradesPrices.push(price)
            } else {
                // Switch on Spot to try
                await managerSpotTrade(
                    action,
                    pair,
                    price,
                    score,
                    stratname,
                    stratid
                )
            }
        } else {
            //Balancing

            // Margin pair, switch on spot
            if (!(margin_pairs.indexOf(pair) >= 0)) {
                console.log("Spot detected, switching on spot...")

                // Switch on Spot
                await managerSpotTrade(
                    action,
                    pair,
                    price,
                    score,
                    stratname,
                    stratid
                )
            } else {
                //Good, rebalance the rest if signal trade succesful

                console.log("Margin detected, balancing on margin...")

                //New quantity
                var newQty = balance_long / (openTrades + 1)

                var addPair = longTradesPairs.push(pair)
                var addPrice = longTradesPrices.push(price)
                var addQty = longTradesQuantities.push(0)

                // Start by 0 to sell, then length for the signal buy

                for (index = 0; index < longTradesPairs.length; index++) {
                    console.log(
                        colors.red(
                            "RECALIBRATING " +
                                longTradesPairs.length +
                                " long trades."
                        )
                    )

                    var pairQueue = longTradesPairs[index]
                    var priceQueue = longTradesPrices[index]
                    var oldQty = longTradesQuantities[index]

                    //Convert oldQty to BTC

                    if (oldQty - newQty < 0) {
                        console.log(
                            "(calibration) BUY " +
                                pairQueue +
                                " " +
                                (newQty - oldQty) +
                                " BTC"
                        )
                        // before qty is less than new qty -> have to buy difference
                        const qtyOK = await buyWrapper(
                            newQty - oldQty,
                            pairQueue,
                            priceQueue,
                            score,
                            stratname,
                            stratid
                        )

                        longTradesQuantities[index] = oldQty + qtyOK

                        console.log(
                            "(calibration) BTC bought " +
                                qtyOK +
                                ", now " +
                                longTradesQuantities[index] +
                                ", was " +
                                oldQty
                        )
                    } else {
                        console.log(
                            "(calibration) SELL " +
                                pairQueue +
                                " " +
                                (oldQty - newQty)
                        )
                        // before qty is more than new qty -> have to sell difference
                        const qtyOK = await sellWrapper(
                            oldQty - newQty,
                            pairQueue,
                            priceQueue,
                            score,
                            stratname,
                            stratid
                        )

                        longTradesQuantities[index] = oldQty - qtyOK

                        console.log(
                            "(calibration) BTC sold " +
                                qtyOK +
                                ", now " +
                                longTradesQuantities[index] +
                                ", was " +
                                oldQty
                        )
                    }

                    //If failed trasnsaction or balance_long now empty for some reason, remove it
                    if (longTradesQuantities[index] == 0) {
                        //Update the trades array
                        var removePair = longTradesPairs.splice(index, 1)
                        var removePrice = longTradesPrices.splice(index, 1)
                        var removeQty = longTradesQuantities.splice(index, 1)
                    }

                    console.log("---")
                }
            }
        }

        // CLOSE action
    } else {
        /*
		// Unregister arrays
		delete(trading_pairs[pair+stratid])
		delete(trading_types[pair+stratid])
		delete(sell_prices[pair+stratid])
		delete(buy_prices[pair+stratid])
		delete(trading_qty[pair+stratid])
		delete(open_trades[pair+stratid])
		//////
		*/

        var openTrades = longTradesPairs.length

        var indexMargin = longTradesPairs.indexOf(pair)

        var indexSpot = longTradesSpotPairs.indexOf(pair)

        // Check if we already have the pair existing: sell from margin and spot, and
        // on both cases the wrapper try to sell on margin then spot. But they doesn't have the same data.
        if (indexMargin >= 0) {
            var pairQueue = longTradesPairs[indexMargin]
            var priceQueue = longTradesPrices[indexMargin]
            var oldQty = longTradesQuantities[indexMargin]

            //Process to sell
            console.log("SELL " + oldQty + " " + pair)
            // before qty is more than new qty -> have to sell difference
            const qtyOK = await sellWrapper(
                oldQty,
                pairQueue,
                priceQueue,
                score,
                stratname,
                stratid
            )

            console.log("SOLD " + qtyOK + " " + pair)

            /*
			const traded_sell_signal = {
				key: BVA_API_KEY,
				stratname: stratname,
				stratid: stratid,
				trading_type: "real",
				pair: pair, 
				qty: qtyOK,
			}
			socket.emit("traded_sell_signal", traded_sell_signal)
			///
			*/

            //Update the trades array
            var removePair = longTradesPairs.splice(indexMargin, 1)
            var removePrice = longTradesPrices.splice(indexMargin, 1)
            var removeQty = longTradesQuantities.splice(indexMargin, 1)
        } else if (indexSpot >= 0) {
            // longTradesSpotPairs

            var pairQueue = longTradesSpotPairs[indexSpot]
            var priceQueue = longTradesSpotPrices[indexSpot]
            var oldQty = longTradesSpotQuantities[indexSpot]

            //Process to sell
            console.log("SELL " + oldQty + " " + pair)
            // before qty is more than new qty -> have to sell difference
            const qtyOK = await sellWrapper(
                oldQty,
                pairQueue,
                priceQueue,
                score,
                stratname,
                stratid
            )

            console.log("SOLD " + qtyOK + " " + pair)

            /*
			const traded_sell_signal = {
				key: BVA_API_KEY,
				stratname: stratname,
				stratid: stratid,
				trading_type: "real",
				pair: pair, 
				qty: qtyOK,
			}
			socket.emit("traded_sell_signal", traded_sell_signal)
			///
			*/

            //Update the trades array
            var removePair = longTradesSpotPairs.splice(indexSpot, 1)
            var removePrice = longTradesSpotPrices.splice(indexSpot, 1)
            var removeQty = longTradesSpotQuantities.splice(indexSpot, 1)
        } else {
            console.log("Couldn't sell asset")
        }
    }

    uploadData(client)
}

// Buy Wrappers to Promise for await functions

function buySpotWrapper(quantity, pair, price, score, stratname, stratid) {
    return new Promise((resolve) => {
        //Process buy
        //qtyOK = buyLongTrade(quantity, pair, price, score, stratname, stratid);
        buySpotTrade(
            quantity,
            pair,
            price,
            score,
            stratname,
            stratid,
            async function (qtyOK) {
                // SEND TRADE EMAIL
                if (send_email) {
                    const mailOptions = {
                        from: '"🐬 BVA " <no-reply@gmail.com>',
                        to: gmail_address,
                        subject:
                            "BUY_SIGNAL :: ENTER LONG TRADE :: " +
                            stratname +
                            " " +
                            pair +
                            " " +
                            price,
                        text: (score ? "score: " + score : "score: NA") + "\n",
                    }
                    mailTransport
                        .sendMail(mailOptions)
                        .then(() => {})
                        .catch((error) => {
                            console.error(
                                "There was an error while sending the email ... trying again..."
                            )
                            setTimeout(() => {
                                mailTransport
                                    .sendMail(mailOptions)
                                    .then(() => {})
                                    .catch((error) => {
                                        console.error(
                                            "There was an error while sending the email: stop trying"
                                        )
                                    })
                            }, 2000)
                        })
                }

                if (slack_url !== "") {
                    const subject =
                        "BUY_SIGNAL :: ENTER LONG TRADE :: " +
                        stratname +
                        " " +
                        pair +
                        " " +
                        price

                    await webhook.send({
                        text: `${subject} \n ${
                            score ? "score: " + score : "score: NA"
                        }`,
                    })
                }

                resolve(qtyOK)
            }
        )
    })
}

function buyWrapper(quantity, pair, price, score, stratname, stratid) {
    return new Promise((resolve) => {
        //Process buy
        //qtyOK = buyLongTrade(quantity, pair, price, score, stratname, stratid);
        buyLongTrade(
            quantity,
            pair,
            price,
            score,
            stratname,
            stratid,
            async function (qtyOK) {
                // SEND TRADE EMAIL
                if (send_email) {
                    const mailOptions = {
                        from: '"🐬 BVA " <no-reply@gmail.com>',
                        to: gmail_address,
                        subject:
                            "BUY_SIGNAL :: ENTER LONG TRADE :: " +
                            stratname +
                            " " +
                            pair +
                            " " +
                            price,
                        text: (score ? "score: " + score : "score: NA") + "\n",
                    }
                    mailTransport
                        .sendMail(mailOptions)
                        .then(() => {})
                        .catch((error) => {
                            console.error(
                                "There was an error while sending the email ... trying again..."
                            )
                            setTimeout(() => {
                                mailTransport
                                    .sendMail(mailOptions)
                                    .then(() => {})
                                    .catch((error) => {
                                        console.error(
                                            "There was an error while sending the email: stop trying"
                                        )
                                    })
                            }, 2000)
                        })
                }

                if (slack_url !== "") {
                    const subject =
                        "BUY_SIGNAL :: ENTER LONG TRADE :: " +
                        stratname +
                        " " +
                        pair +
                        " " +
                        price

                    await webhook.send({
                        text: `${subject} \n ${
                            score ? "score: " + score : "score: NA"
                        }`,
                    })
                }

                resolve(qtyOK)
            }
        )
    })
}

// Sell Wrapper to Promise for await functions
function sellWrapper(quantity, pair, price, score, stratname, stratid) {
    return new Promise(async (resolve) => {
        //Process buy
        //qtyOK = sellLongTrade(oldQty - newQty, pairQueue, priceQueue, score, stratname, stratid);
        await sellLongTrade(
            quantity,
            pair,
            price,
            score,
            stratname,
            stratid,
            async function (qtyOK) {
                // SEND TRADE EMAIL
                if (send_email) {
                    const mailOptions = {
                        from: '"🐬  BVA " <no-reply@gmail.com>',
                        to: gmail_address,
                        subject:
                            "SELL_SIGNAL :: SELL TO EXIT LONG TRADE :: " +
                            stratname +
                            " " +
                            pair,
                        text: (score ? "score: " + score : "score: NA") + "\n",
                    }
                    mailTransport
                        .sendMail(mailOptions)
                        .then(() => {})
                        .catch((error) => {
                            console.error(
                                "There was an error while sending the email ... trying again..."
                            )
                            setTimeout(() => {
                                mailTransport
                                    .sendMail(mailOptions)
                                    .then(() => {})
                                    .catch((error) => {
                                        console.error(
                                            "There was an error while sending the email: stop trying"
                                        )
                                    })
                            }, 2000)
                        })
                }

                if (slack_url !== "") {
                    const subject =
                        "SELL_SIGNAL :: SELL TO EXIT LONG TRADE :: " +
                        stratname +
                        " " +
                        pair

                    await webhook.send({
                        text: `${subject} \n ${
                            score ? "score: " + score : "score: NA"
                        }`,
                    })
                }

                resolve(qtyOK)
            }
        )
    })
}

function buyLongTrade(
    quantity,
    pair,
    price,
    score,
    stratname,
    stratid,
    callback
) {
    var returnQty = 0 // Quantity actually traded at end

    const tresult = _.findIndex(user_payload, (o) => {
        return o.stratid == stratid
    })

    console.log(
        colors.grey(
            "BUY_SIGNAL :: ENTER LONG TRADE ::",
            stratname,
            stratid,
            pair
        )
    )

    console.log(pair, " ===> BUY", price, Number(quantity))
    if (pair == "BTCUSDT") {
        trading_qty[pair + stratid] = Number(quantity)

        if ("real" === "real") {
            bnb_client.mgMarketBuy(
                "BTCUSDT",
                Number(quantity),
                (error, response) => {
                    if (error)
                        console.log(
                            "ERROR 3 BTCUSDT ",
                            Number(quantity),
                            error.body
                        )
                    if (response) console.log(" mgMarketBuy BTCUSDT SUCESS 3")
                }
            )
        }
    } else {
        const alt = pair.replace("USDT", "")

        minimums_alt = minimums[alt + "USDT"]
        if (minimums[alt + "USDT"].minQty) {
            const buy_amount = new BigNumber(quantity)
            const btc_qty = buy_amount.dividedBy(price)
            const qty = bnb_client.roundStep(
                btc_qty,
                minimums[alt + "USDT"].stepSize
            )
            console.log("Market Buy ==> " + qty + " - " + alt + "USDT")
            trading_qty[pair + stratid] = Number(qty)

            if (test_trades == true) {
                emulateBuy(alt + "USDT", Number(qty), price)
                returnQty = Number(qty * price)
            }

            //mgMarketBuy to marketBuy if spot test
            bnb_client.mgMarketBuy(
                alt + "USDT",
                Number(qty),
                (error, response) => {
                    if (error) {
                        // ADD NORMAL MARKET TRADE
                        console.log("ERROR 3355333", error.body)

                        callback(returnQty)
                        //return returnQty;
                    } else {
                        console.log("Trade success 222444222")
                        returnQty = Number(qty * price)

                        callback(returnQty)
                        //return returnQty;
                    }
                }
            )
        } else {
            console.log("PAIR UNKNOWN", alt)
        }
    }

    return returnQty
}

function buySpotTrade(
    quantity,
    pair,
    price,
    score,
    stratname,
    stratid,
    callback
) {
    var returnQty = 0 // Quantity actually traded at end

    const tresult = _.findIndex(user_payload, (o) => {
        return o.stratid == stratid
    })

    console.log(
        colors.grey(
            "BUY_SIGNAL :: ENTER LONG TRADE (SPOT) ::",
            stratname,
            stratid,
            pair
        )
    )

    console.log(pair, " ===> BUY", price, Number(quantity))
    if (pair == "BTCUSDT") {
        trading_qty[pair + stratid] = Number(quantity)

        if ("real" === "real") {
            bnb_client.mgMarketBuy(
                "BTCUSDT",
                Number(quantity),
                (error, response) => {
                    if (error)
                        console.log(
                            "ERROR 3 BTCUSDT ",
                            Number(quantity),
                            error.body
                        )
                    if (response) console.log(" mgMarketBuy BTCUSDT SUCESS 3")
                }
            )
        }
    } else {
        const alt = pair.replace("USDT", "")

        if (minimums[alt + "USDT"].minQty) {
            const buy_amount = new BigNumber(quantity)
            const btc_qty = buy_amount.dividedBy(price)
            const qty = bnb_client.roundStep(
                btc_qty,
                minimums[alt + "USDT"].stepSize
            )
            console.log("Market Buy ==> " + qty + " - " + alt + "BTC")
            trading_qty[pair + stratid] = Number(qty)

            if (test_trades == true) {
                emulateBuy(alt + "USDT", Number(qty), price)
                returnQty = Number(qty * price)
            }

            //mgMarketBuy to marketBuy if spot test
            bnb_client.marketBuy(
                alt + "USDT",
                Number(qty),
                (error, response) => {
                    if (error) {
                        // ADD NORMAL MARKET TRADE
                        console.log("ERROR 255255", error.body)

                        callback(returnQty)
                        //return returnQty;
                    } else {
                        console.log("Trade success 311311")
                        returnQty = Number(qty * price)

                        callback(returnQty)
                        //return returnQty;
                    }
                }
            )
        } else {
            console.log("PAIR UNKNOWN", alt)
        }
    }

    return returnQty
}

async function sellLongTrade(
    quantity,
    pair,
    price,
    score,
    stratname,
    stratid,
    callback
) {
    var returnQty = 0 // Quantity actually traded at end

    const tresult = _.findIndex(user_payload, (o) => {
        return o.stratid == stratid
    })

    console.log(
        colors.grey(
            "SELL_SIGNAL :: SELL TO EXIT LONG TRADE ::",
            stratname,
            stratid,
            pair
        )
    )
    console.log(pair, " ---> SELL", Number(quantity))

    const alt = pair.replace("BTC", "")

    if (minimums[alt + "BTC"].minQty) {
        const sell_amount = new BigNumber(quantity)
        const btc_qty = sell_amount.dividedBy(price)
        const qty = bnb_client.roundStep(
            btc_qty,
            minimums[alt + "BTC"].stepSize
        )

        console.log(
            "QTY =======mgMarketSell======> " + Number(qty) + " - " + alt
        )

        if (test_trades == true) {
            emulateSell(alt + "BTC", Number(qty))
            returnQty = Number(qty * price)
        }

        //mgMarketBuy to marketBuy if spot test
        bnb_client.mgMarketSell(alt + "BTC", Number(qty), (error, response) => {
            if (error) {
                // FALLBACK ON NORMAL SPOT TRADE
                bnb_client.marketSell(
                    alt + "BTC",
                    Number(qty),
                    (error, response) => {
                        if (error) {
                            console.log(
                                "ERROR 722211117",
                                alt,
                                Number(qty),
                                error.body
                            )
                            callback(returnQty)
                        } else {
                            console.log("SUCESS 71111444", alt, Number(qty))
                            returnQty = Number(qty * price)
                            callback(returnQty)
                        }
                    }
                )
            } else {
                console.log("SUCESS 71111111", alt, Number(qty))

                returnQty = Number(qty * price)

                callback(returnQty)
            }
        })

        ///
    } else {
        console.log("PAIR UNKNOWN", alt)
    }
}

//}

//{ SOCKET

socket.on("buy_signal", async (signal) => {
    const payload = await getUserPayload()
    console.log(signal)
    const tresult = _.findIndex(payload.userPayload, (o) => {
        return o.stratid == signal.stratid
    })
    if (tresult > -1) {
        //BUY LONG TRADE

        if (
            !(longTradesPairs.indexOf(signal.pair) >= 0) &&
            !(
                longTradesSpotPairs.indexOf(signal.pair) >= 0
            ) /* doesn't exist in local lib */ &&
            signal.new
        ) {
            await managerTrade(
                1,
                signal.pair,
                signal.price,
                signal.score,
                signal.stratname,
                signal.stratid
            )
        }

        //BUY SHORT TRADE (COVER)
        else if (
            trading_types[signal.pair + signal.stratid] === "SHORT" &&
            trading_qty[signal.pair + signal.stratid] &&
            !signal.new &&
            open_trades[signal.pair + signal.stratid]
        ) {
            console.log(
                colors.grey(
                    "BUY_SIGNAL :: BUY TO COVER SHORT TRADE ::",
                    signal.stratname,
                    signal.stratid,
                    signal.pair
                )
            )

            console.log(
                signal.pair,
                " ---> BUY",
                Number(trading_qty[signal.pair + signal.stratid])
            )

            // SEND TRADE EMAIL
            if (send_email) {
                const mailOptions = {
                    from: '"🐬  BVA " <no-reply@gmail.com>',
                    to: gmail_address,
                    subject:
                        "BUY_SIGNAL :: BUY TO COVER SHORT TRADE :: " +
                        signal.stratname +
                        " " +
                        signal.pair +
                        " " +
                        signal.price,
                    text:
                        (signal.score
                            ? "score: " + signal.score
                            : "score: NA") + "\n",
                }
                mailTransport
                    .sendMail(mailOptions)
                    .then(() => {})
                    .catch((error) => {
                        console.error(
                            "There was an error while sending the email ... trying again..."
                        )
                        setTimeout(() => {
                            mailTransport
                                .sendMail(mailOptions)
                                .then(() => {})
                                .catch((error) => {
                                    console.error(
                                        "There was an error while sending the email: stop trying"
                                    )
                                })
                        }, 2000)
                    })
            }

            if (slack_url !== "") {
                const subject =
                    "BUY_SIGNAL :: BUY TO COVER SHORT TRADE :: " +
                    signal.stratname +
                    " " +
                    signal.pair +
                    " " +
                    signal.price
                await webhook.send({
                    text: `${subject} \n ${
                        signal.score
                            ? "score: " + signal.APIKEYscore
                            : "score: NA"
                    }`,
                })
            }

            if (signal.pair == "BTCUSDT") {
                /////
                const traded_buy_signal = {
                    key: BVA_API_KEY,
                    stratname: signal.stratname,
                    stratid: signal.stratid,
                    trading_type: user_payload[tresult].trading_type,
                    pair: signal.pair,
                    qty: Number(trading_qty[signal.pair + signal.stratid]),
                }
                socket.emit("traded_buy_signal", traded_buy_signal)
                /////

                if (user_payload[tresult].trading_type === "real") {
                    const qty = Number(
                        trading_qty[signal.pair + signal.stratid]
                    )

                    bnb_client.mgMarketBuy(
                        "BTCUSDT",
                        qty,
                        (error, response) => {
                            if (error)
                                console.log("ERROR 5 BTCUST ", qty, error.body)
                            if (response) {
                                console.log("----- mgRepay BTC 5 -----")
                                bnb_client.mgRepay(
                                    "BTC",
                                    qty,
                                    (error, response) => {
                                        if (error)
                                            console.log(
                                                "ERROR BTC 999",
                                                qty,
                                                error.body
                                            )
                                        else console.log("SUCCESS BTC 888")
                                    }
                                )
                            }
                        }
                    )
                }
            } else {
                const alt = signal.pair.replace("BTC", "")

                if (minimums[alt + "BTC"].minQty) {
                    const qty = Number(
                        trading_qty[signal.pair + signal.stratid]
                    )
                    console.log(
                        "QTY ====mgMarketBuy===> " + qty + " - " + alt + "BTC"
                    )
                    /////
                    const traded_buy_signal = {
                        key: BVA_API_KEY,
                        stratname: signal.stratname,
                        stratid: signal.stratid,
                        trading_type: user_payload[tresult].trading_type,
                        pair: signal.pair,
                        qty: qty,
                    }

                    socket.emit("traded_buy_signal", traded_buy_signal)
                    /////
                    if (user_payload[tresult].trading_type === "real") {
                        bnb_client.mgMarketBuy(
                            alt + "BTC",
                            Number(qty),
                            (error, response) => {
                                if (error)
                                    console.log(
                                        "ERROR 6 ",
                                        alt,
                                        Number(qty),
                                        error.body
                                    )
                                if (response) {
                                    console.log("---+-- mgRepay ---+--")
                                    bnb_client.mgRepay(
                                        alt,
                                        Number(qty),
                                        (error, response) => {
                                            if (error)
                                                console.log(
                                                    "ERROR 244343333",
                                                    alt,
                                                    Number(qty),
                                                    error.body
                                                )
                                            else
                                                console.log("SUCCESS 333342111")
                                        }
                                    )
                                }
                            }
                        )
                    }
                } else {
                    console.log("PAIR UNKNOWN", alt)
                }
            }
            //////
            delete trading_pairs[signal.pair + signal.stratid]
            delete trading_types[signal.pair + signal.stratid]
            delete buy_prices[signal.pair + signal.stratid]
            delete sell_prices[signal.pair + signal.stratid]
            delete trading_qty[signal.pair + signal.stratid]
            delete open_trades[signal.pair + signal.stratid]
            //////
        } else {
            console.log(
                "BUY AGAIN",
                signal.stratname,
                signal.pair,
                longTradesPairs.indexOf(signal.pair)
            )
        }
    }
})

socket.on("sell_signal", async (signal) => {
    const tresult = _.findIndex(user_payload, (o) => {
        return o.stratid == signal.stratid
    })

    if (tresult > -1) {
        // SELL SHORT TRADE
        if (!trading_pairs[signal.pair + signal.stratid] && signal.new) {
            console.log(
                colors.grey(
                    "SELL_SIGNAL :: ENTER SHORT TRADE ::",
                    signal.stratname,
                    signal.stratid,
                    signal.pair
                )
            )

            // SEND TRADE EMAIL
            if (send_email) {
                const mailOptions = {
                    from: '"🐬  BVA " <no-reply@gmail.com>',
                    to: gmail_address,
                    subject:
                        "SELL_SIGNAL :: ENTER SHORT TRADE :: " +
                        signal.stratname +
                        " " +
                        signal.pair +
                        " " +
                        signal.price,
                    text:
                        (signal.score
                            ? "score: " + signal.score
                            : "score: NA") + "\n",
                }
                mailTransport
                    .sendMail(mailOptions)
                    .then(() => {})
                    .catch((error) => {
                        console.error(
                            "There was an error while sending the email ... trying again..."
                        )
                        setTimeout(() => {
                            mailTransport
                                .sendMail(mailOptions)
                                .then(() => {})
                                .catch((error) => {
                                    console.error(
                                        "There was an error while sending the email: stop trying"
                                    )
                                })
                        }, 2000)
                    })
            }

            if (slack_url !== "") {
                const subject =
                    "SELL_SIGNAL :: ENTER SHORT TRADE :: " +
                    signal.stratname +
                    " " +
                    signal.pair +
                    " " +
                    signal.price
                await webhook.send({
                    text: `${subject} \n ${
                        signal.score ? "score: " + signal.score : "score: NA"
                    }`,
                })
            }

            //////
            trading_pairs[signal.pair + signal.stratid] = true
            trading_types[signal.pair + signal.stratid] = "SHORT"
            open_trades[signal.pair + signal.stratid] = true
            //////

            console.log(
                signal.pair,
                " ===> SELL",
                signal.price,
                Number(balance_short)
            )
            if (signal.pair == "BTCUSDT") {
                trading_qty[signal.pair + signal.stratid] =
                    Number(balance_short)
                const traded_sell_signal = {
                    key: BVA_API_KEY,
                    stratname: signal.stratname,
                    stratid: signal.stratid,
                    trading_type: user_payload[tresult].trading_type,
                    pair: signal.pair,
                    qty: Number(balance_short),
                }
                socket.emit("traded_sell_signal", traded_sell_signal)
                if (user_payload[tresult].trading_type === "real") {
                    bnb_client.mgBorrow(
                        "BTC",
                        Number(balance_short),
                        (error, response) => {
                            if (error)
                                console.log(
                                    "ERROR BTC 55",
                                    Number(balance_short),
                                    error.body
                                )
                            else {
                                console.log("SUCESS BTC 4 mgMarketSell 444")

                                bnb_client.mgMarketSell(
                                    "BTCUSDT",
                                    Number(balance_short),
                                    (error, response) => {
                                        if (error)
                                            console.log(
                                                "ERROR BTC 33333",
                                                error.body
                                            )
                                        else
                                            console.log(
                                                "mgMarketSell BTCUSDT SUCCESS 2222"
                                            )
                                    }
                                )
                            }
                        }
                    )
                }
            } else {
                const alt = signal.pair.replace("BTC", "")
                if (minimums[alt + "BTC"].minQty) {
                    const buy_amount = new BigNumber(balance_short)
                    const btc_qty = buy_amount.dividedBy(signal.price)
                    const qty = bnb_client.roundStep(
                        btc_qty,
                        minimums[alt + "BTC"].stepSize
                    )
                    trading_qty[signal.pair + signal.stratid] = Number(qty)
                    console.log(
                        "QTY ===mgBorrow===> " + qty + " - " + alt + "BTC"
                    )
                    const traded_sell_signal = {
                        key: BVA_API_KEY,
                        stratname: signal.stratname,
                        stratid: signal.stratid,
                        trading_type: user_payload[tresult].trading_type,
                        pair: signal.pair,
                        qty: qty,
                    }
                    socket.emit("traded_sell_signal", traded_sell_signal)

                    if (user_payload[tresult].trading_type === "real") {
                        bnb_client.mgBorrow(
                            alt,
                            Number(qty),
                            (error, response) => {
                                if (error) {
                                    console.log(
                                        "ERROR 55555555555",
                                        alt,
                                        Number(qty),
                                        JSON.stringify(error)
                                    )
                                } else {
                                    console.log(
                                        "SUCESS 444444444 mgMarketSell 44444444"
                                    )
                                    bnb_client.mgMarketSell(
                                        alt + "BTC",
                                        Number(qty),
                                        (error, response) => {
                                            if (error)
                                                console.log(
                                                    "ERROR 333333333",
                                                    JSON.stringify(error)
                                                )
                                            else console.log("SUCCESS 22222222")
                                        }
                                    )
                                }
                            }
                        )
                    }
                } else {
                    console.log("PAIR UNKNOWN", alt)
                }
            }
            //////
        }

        // SELL LONG MARGIN TRADE
        else if (
            longTradesPairs.indexOf(signal.pair) >=
                0 /* exist in local lib */ &&
            !signal.new
        ) {
            await managerTrade(
                -1,
                signal.pair,
                signal.price,
                signal.score,
                signal.stratname,
                signal.stratid
            )
        }

        // SELL LONG SPOT TRADE
        else if (
            longTradesSpotPairs.indexOf(signal.pair) >=
                0 /* exist in local lib */ &&
            !signal.new
        ) {
            await managerTrade(
                -1,
                signal.pair,
                signal.price,
                signal.score,
                signal.stratname,
                signal.stratid
            )
        } else {
            console.log(
                "SELL AGAIN",
                signal.stratname,
                signal.pair,
                !signal.new,
                open_trades[signal.pair + signal.stratid],
                trading_types[signal.pair + signal.stratid],
                longTradesPairs.indexOf(signal.pair)
            )
        }
    }
})

//}

//{ UTILITIES

async function UpdateMarginPairs() {
    return new Promise((resolve, reject) => {
        axios
            .get(
                "https://www.binance.com/gateway-api/v1/friendly/margin/symbols"
            )
            .then((res) => {
                let list = res.data.data.map((obj) => obj.symbol)
                margin_pairs = list.sort()
                console.log("Margin Pairs:", margin_pairs)
                resolve(margin_pairs)
            })
            .catch((e) => {
                console.log("ERROR UpdateMarginPairs", e.response.data)
                return reject(e.response.data)
            })
    })
}

async function ExchangeInfo() {
    return new Promise((resolve, reject) => {
        bnb_client.exchangeInfo((error, data) => {
            if (error !== null) {
                console.log(error)
                return reject(error)
            }
            for (let obj of data.symbols) {
                let filters = { status: obj.status }
                for (let filter of obj.filters) {
                    if (filter.filterType == "MIN_NOTIONAL") {
                        filters.minNotional = filter.minNotional
                    } else if (filter.filterType == "PRICE_FILTER") {
                        filters.minPrice = filter.minPrice
                        filters.maxPrice = filter.maxPrice
                        filters.tickSize = filter.tickSize
                    } else if (filter.filterType == "LOT_SIZE") {
                        filters.stepSize = filter.stepSize
                        filters.minQty = filter.minQty
                        filters.maxQty = filter.maxQty
                    }
                }
                filters.orderTypes = obj.orderTypes
                filters.icebergAllowed = obj.icebergAllowed
                minimums[obj.symbol] = filters
            }
            resolve(true)
        })
    })
}

async function UpdateOpenTrades() {
    return new Promise((resolve, reject) => {
        // Retrieve previous open trades //
        axios
            .get(
                "https://bitcoinvsaltcoins.com/api/useropentradedsignals?key=" +
                    BVA_API_KEY
            )
            .then((response) => {
                response.data.rows.map((s) => {
                    trading_pairs[s.pair + s.stratid] = true
                    open_trades[s.pair + s.stratid] = !s.stopped
                    trading_types[s.pair + s.stratid] = s.type
                    trading_qty[s.pair + s.stratid] = s.qty
                    buy_prices[s.pair + s.stratid] = new BigNumber(s.buy_price)
                    sell_prices[s.pair + s.stratid] = new BigNumber(
                        s.sell_price
                    )
                })
                console.log("Open Trades:", _.values(trading_pairs).length)
                console.log(open_trades)
                resolve(true)
            })
            .catch((e) => {
                console.log("ERROR UpdateOpenTrades", e.response.data)
                return reject(false)
            })
    })
}

function balance_update(data) {
    /*
	console.log("Balance Update");
	for ( let obj of data.B ) {
		let { a:asset, f:available, l:onOrder } = obj;
		if ( available == "0.00000000" ) continue;
		
		
		console.log(asset+"\tavailable: "+available+" ("+onOrder+" on order)");
		
		longTradesPairs.forEach(function(item, index, array) {
			
			var pair = asset + 'BTC';
			
			if(pair.localeCompare(longTradesPairs[index]) == 0){
				//longTradesQuantities[index] = Number(available*longTradesPrices[index]);
				console.log("Updated known balance_long by "+ available*longTradesPrices[index]+ " BTC");				
			}
		  
		});
	}
	*/
}

//{ MongoDB related functions

async function downloadData() {
    databasesList = await db.db().admin().listDatabases()
    console.log("Checking DB link, listing collections:")
    databasesList.databases.forEach((db) => console.log(` - ${db.name}`))

    var dbo = db.db("update_data")

    // Data used:
    // longTradesPairs: pair_data
    // longTradesPrices: price_data
    // longTradesQuantities: quantity_data

    await dbo.collection("pair_data").findOne({}, function (err, result) {
        if (err) console.log(err)

        if (result != null) {
            console.log("[DOWNLOADING MARGIN DATA]")

            if (result.data != null) {
                console.log("[DOWNLOADING PAIRS")
                // We can parse the new data now
                console.log(result.data)
                longTradesPairs = JSON.parse(result.data)
                console.log(longTradesPairs)
                console.log("]")
            }
        }
    })

    await dbo.collection("price_data").findOne({}, function (err, result) {
        if (err) console.log(err)

        if (result != null) {
            if (result.data != null) {
                console.log("[DOWNLOADING PRICES")
                // We can parse the new data now
                console.log(result.data)
                longTradesPrices = JSON.parse(result.data)
                console.log(longTradesPrices)
                console.log("]")
            }
        }
    })

    await dbo.collection("quantity_data").findOne({}, function (err, result) {
        if (err) console.log(err)

        if (result != null) {
            if (result.data != null) {
                console.log("[DOWNLOADING QUANTITIES")
                // We can parse the new data now
                console.log(result.data)
                longTradesQuantities = JSON.parse(result.data)
                console.log(longTradesQuantities)
                console.log("]")
            }
        }
    })

    await dbo.collection("spot_pair_data").findOne({}, function (err, result) {
        if (err) console.log(err)

        if (result != null) {
            console.log("[DOWNLOADING SPOT DATA]")

            if (result.data != null) {
                console.log("[DOWNLOADING PAIRS")
                // We can parse the new data now
                console.log(result.data)
                longTradesSpotPairs = JSON.parse(result.data)
                console.log(longTradesSpotPairs)
                console.log("]")
            }
        }
    })

    await dbo.collection("spot_price_data").findOne({}, function (err, result) {
        if (err) console.log(err)

        if (result != null) {
            if (result.data != null) {
                console.log("[DOWNLOADING PRICES")
                // We can parse the new data now
                console.log(result.data)
                longTradesSpotPrices = JSON.parse(result.data)
                console.log(longTradesSpotPrices)
                console.log("]")
            }
        }
    })

    await dbo
        .collection("spot_quantity_data")
        .findOne({}, function (err, result) {
            if (err) console.log(err)

            if (result != null) {
                if (result.data != null) {
                    console.log("[DOWNLOADING QUANTITIES")
                    // We can parse the new data now
                    console.log(result.data)
                    longTradesSpotQuantities = JSON.parse(result.data)
                    console.log(longTradesSpotQuantities)
                    console.log("]")
                }
            }
        })
}

async function saveUserPayload(data) {
    const dbo = db.db("update_data")
    await dbo.collection("userPayload").updateOne(
        { payload: "local" },
        {
            $set: { userPayload: data },
        },
        { upsert: true }
    )
}

async function getUserPayload() {
    const dbo = db.db("update_data")
    return await dbo.collection("userPayload").findOne({ payload: "local" })
}

async function uploadData() {
    databasesList = await db.db().admin().listDatabases()
    console.log("Databases:")
    databasesList.databases.forEach((db) => console.log(` - ${db.name}`))

    var dbo = db.db("update_data")

    // Data used:
    // longTradesPairs: pair_data
    // longTradesPrices: price_data
    // longTradesQuantities: quantity_data

    await dbo.collection("pair_data").drop(async function (err, delOK) {
        if (err) console.log(err)

        if (delOK) {
            console.log("[UPLOADING MARGIN DATA]")

            console.log("[UPLOAD PAIRS")

            // All previous data is now deleted, we can upload our own

            console.log("Collection deleted")

            var data = JSON.stringify(longTradesPairs)
            console.log(data)

            var uploadObject = { data }

            await dbo
                .collection("pair_data")
                .insertOne(uploadObject, function (err, res) {
                    if (err) console.log(err)
                    console.log("Data uploaded " + data)
                })

            console.log("]")
        }
    })

    await dbo.collection("price_data").drop(async function (err, delOK) {
        if (err) console.log(err)

        if (delOK) {
            console.log("[UPLOAD PRICES")

            // All previous data is now deleted, we can upload our own

            console.log("Collection deleted")

            var data = JSON.stringify(longTradesPrices)
            console.log(data)

            var uploadObject = { data }

            await dbo
                .collection("price_data")
                .insertOne(uploadObject, function (err, res) {
                    if (err) console.log(err)
                    console.log("Data uploaded " + data)
                })

            console.log("]")
        }
    })

    await dbo.collection("quantity_data").drop(async function (err, delOK) {
        if (err) console.log(err)

        if (delOK) {
            console.log("[UPLOAD QUANTITIES")

            // All previous data is now deleted, we can upload our own

            console.log("Collection deleted")

            var data = JSON.stringify(longTradesQuantities)
            console.log(data)

            var uploadObject = { data }

            await dbo
                .collection("quantity_data")
                .insertOne(uploadObject, function (err, res) {
                    if (err) console.log(err)
                    console.log("Data uploaded " + data)
                })

            console.log("]")
        }
    })

    await dbo.collection("spot_pair_data").drop(async function (err, delOK) {
        if (err) console.log(err)

        if (delOK) {
            console.log("[UPLOADING SPOT DATA]")

            console.log("[UPLOAD PAIRS")

            // All previous data is now deleted, we can upload our own

            console.log("Collection deleted")

            var data = JSON.stringify(longTradesSpotPairs)
            console.log(data)

            var uploadObject = { data }

            await dbo
                .collection("spot_pair_data")
                .insertOne(uploadObject, function (err, res) {
                    if (err) console.log(err)
                    console.log("Data uploaded " + data)
                })

            console.log("]")
        }
    })

    await dbo.collection("spot_price_data").drop(async function (err, delOK) {
        if (err) console.log(err)

        if (delOK) {
            console.log("[UPLOAD PRICES")

            // All previous data is now deleted, we can upload our own

            console.log("Collection deleted")

            var data = JSON.stringify(longTradesSpotPrices)
            console.log(data)

            var uploadObject = { data }

            await dbo
                .collection("spot_price_data")
                .insertOne(uploadObject, function (err, res) {
                    if (err) console.log(err)
                    console.log("Data uploaded " + data)
                })

            console.log("]")
        }
    })

    await dbo
        .collection("spot_quantity_data")
        .drop(async function (err, delOK) {
            if (err) console.log(err)

            if (delOK) {
                console.log("[UPLOAD QUANTITIES")

                // All previous data is now deleted, we can upload our own

                console.log("Collection deleted")

                var data = JSON.stringify(longTradesSpotQuantities)
                console.log(data)

                var uploadObject = { data }

                await dbo
                    .collection("spot_quantity_data")
                    .insertOne(uploadObject, function (err, res) {
                        if (err) console.log(err)
                        console.log("Data uploaded " + data)
                    })

                console.log("]")
            }
        })
}

async function initializeDatabases() {
    var dbo = db.db("update_data")

    // Data used:
    // longTradesPairs: pair_data
    // longTradesPrices: price_data
    // longTradesQuantities: quantity_data

    console.log("[")
    var data = JSON.stringify(longTradesPairs)
    console.log(data)
    var uploadObject = { data }
    await dbo
        .collection("pair_data")
        .insertOne(uploadObject, function (err, res) {
            if (err) console.log(err)
            console.log("Data uploaded " + data)
        })
    console.log("]")

    console.log("[")
    var data = JSON.stringify(longTradesPrices)
    console.log(data)
    var uploadObject = { data }
    await dbo
        .collection("price_data")
        .insertOne(uploadObject, function (err, res) {
            if (err) console.log(err)
            console.log("Data uploaded " + data)
        })
    console.log("]")

    console.log("[")
    var data = JSON.stringify(longTradesQuantities)
    console.log(data)
    var uploadObject = { data }

    await dbo
        .collection("quantity_data")
        .insertOne(uploadObject, function (err, res) {
            if (err) console.log(err)
            console.log("Data uploaded " + data)
        })
    console.log("]")

    console.log("[")
    var data = JSON.stringify(longTradesSpotPairs)
    console.log(data)
    var uploadObject = { data }
    await dbo
        .collection("spot_pair_data")
        .insertOne(uploadObject, function (err, res) {
            if (err) console.log(err)
            console.log("Data uploaded " + data)
        })
    console.log("]")

    console.log("[")
    var data = JSON.stringify(longTradesSpotPrices)
    console.log(data)
    var uploadObject = { data }
    await dbo
        .collection("spot_price_data")
        .insertOne(uploadObject, function (err, res) {
            if (err) console.log(err)
            console.log("Data uploaded " + data)
        })
    console.log("]")

    console.log("[")
    var data = JSON.stringify(longTradesSpotQuantities)
    console.log(data)
    var uploadObject = { data }

    await dbo
        .collection("spot_quantity_data")
        .insertOne(uploadObject, function (err, res) {
            if (err) console.log(err)
            console.log("Data uploaded " + data)
        })
    console.log("]")
}

//}

async function checkExchangeDebug() {
    /* No need to emulate closure
	
	console.log("deletetest");
		
	var pair = "IOTABTC";
	var stratid = 466;
	//////
	delete(trading_pairs[pair+stratid])
	delete(trading_types[pair+stratid])
	delete(buy_prices[pair+stratid])
	delete(trading_qty[pair+stratid])
	delete(open_trades[pair+stratid])
	//////
	
	const traded_sell_signal = {
		key: BVA_API_KEY,
		stratname: "BVA",
		stratid: 466,
		trading_type: "real",
		pair: "NANOBTC", 
		qty: 30,
	}
	await socket.emit("traded_sell_signal", traded_sell_signal)
	
	await UpdateOpenTrades()
	
	console.log("deletedone");
	*/
}

async function run() {
    bnb_client.websockets.userMarginData(balance_update, function (data) {})

    await ExchangeInfo()
    await UpdateOpenTrades()
    await UpdateMarginPairs()
    await downloadData()

    await checkExchangeDebug()

    if (init_db == true) {
        await initializeDatabases()
        init_db = false
    }

    // Emulation testbench
    if (false) {
        //['BNBBTC', 'NEOBTC', 'XRPBTC', 'ZRXBTC', 'ADABTC', 'TOMOBTC', 'XTZBTC', 'RENBTC']
        /*
		managerTrade(1, "XRPBTC", 0.00001076, 1, "BVA", 466);
		showBalance();
		managerTrade(1, "LTCBTC", 0.00001076, 0.6, "BVA", 466);
		showBalance();
		managerTrade(1, "ZRXBTC", 0.00003240, 0.6, "BVA", 466);
		showBalance();
		managerTrade(1, "RENBTC", 0.00001819, 0.6, "BVA", 466);
		showBalance();
		managerTrade(1, "TOMOBTC", 0.00003936, 0.6, "BVA", 466);
		showBalance();
		managerTrade(1, "XTZBTC", 0.00007830, 0.6, "BVA", 466);
		showBalance();
		
		// SELL THREE
		
		console.log("------------ SELL TEST ------------");

		managerTrade(-1, "TOMOBTC", 0.00003936, 0.6, "BVA", 466);
		managerTrade(-1, "XTZBTC", 0.00007830, 0.6, "BVA", 466);
		managerTrade(-1, "RENBTC", 0.00001819, 0.6, "BVA", 466);
		showBalance();
		
		console.log("------------ BUY AGAIN TEST --------");
		
		managerTrade(1, "XTZBTC", 0.00003936, 0.6, "BVA", 466);
		managerTrade(1, "RENBTC", 0.00007830, 0.6, "BVA", 466);
		showBalance();
		
		console.log("------------ SELL EVERYTHING --------");
		
		managerTrade(-1, "BNBBTC", 0.00169200, 1, "BVA", 466);
		showBalance();
		managerTrade(-1, "NEOBTC", 0.00069900, 1, "BVA", 466);
		showBalance();
		managerTrade(-1, "XRPBTC", 0.00001076, 0.6, "BVA", 466);
		showBalance();
		managerTrade(-1, "ZRXBTC", 0.00003240, 0.6, "BVA", 466);
		showBalance();
		managerTrade(-1, "RENBTC", 0.00001819, 0.6, "BVA", 466);
		showBalance();
		managerTrade(-1, "XTZBTC", 0.00007830, 0.6, "BVA", 466);
		showBalance();
		
		console.log("------------ MEDIUM TEST -----------");
		
		managerTrade(1, "BNBBTC", 0.00169200, 1, "BVA", 466);
		managerTrade(1, "NEOBTC", 0.00069900, 1, "BVA", 466);
		managerTrade(1, "XRPBTC", 0.00001076, 0.6, "BVA", 466);
		showBalance();
		
		managerTrade(-1, "XRPBTC", 0.00001076, 0.6, "BVA", 466);
		showBalance();
		
		managerTrade(1, "XRPBTC", 0.00001076, 0.6, "BVA", 466);
		showBalance();
		
		console.log("------------ ALTERN BUY SELL -----------");
		
		managerTrade(1, "RENBTC", 0.00001819, 0.6, "BVA", 466);
		showBalance();
		
		managerTrade(-1, "XRPBTC", 0.00001076, 0.6, "BVA", 466);
		showBalance();
		
		managerTrade(1, "TOMOBTC", 0.00003936, 0.6, "BVA", 466);
		showBalance();
		
		managerTrade(-1, "RENBTC", 0.00001076, 0.6, "BVA", 466);
		managerTrade(-1, "TOMOBTC", 0.00003936, 0.6, "BVA", 466);
		showBalance();
		
		managerTrade(1, "XRPBTC", 0.00001076, 0.6, "BVA", 466);
		showBalance();
		*/

        // Real testbench

        setTimeout(() => {
            console.log("Adding 1 more!")
            managerTrade(-1, "ADABTC", 0.00002616, 1, "BVA", 466)
        }, 5000 /* miliseconds since start on when to run trade */)

        setTimeout(() => {
            console.log("Adding 1 more!")
            managerTrade(-1, "QTUMBTC", 0.0001002, 1, "BVA", 466)
        }, 30000 /* miliseconds since start on when to run trade */)

        setTimeout(() => {
            console.log("Adding 1 more!")
            managerTrade(-1, "ETHBTC", 0.030574, 1, "BVA", 466)
        }, 50000 /* miliseconds since start on when to run trade */)

        setTimeout(() => {
            console.log("Adding 1 more!")
            managerTrade(-1, "TOMOBTC", 0.00003955, 1, "BVA", 466)
        }, 5000 /* miliseconds since start on when to run trade */)

        setTimeout(() => {
            console.log("Adding 1 more!")
            managerTrade(-1, "MTLBTC", 0.00002898, 1, "BVA", 466)
        }, 15000 /* miliseconds since start on when to run trade */)

        setTimeout(() => {
            console.log("Adding 1 more!")
            managerTrade(-1, "NANOBTC", 0.0000928, 1, "BVA", 466)
        }, 30000 /* miliseconds since start on when to run trade */)

        // Real benchmark

        //await managerTrade(-1, "BNBBTC", 0.0025674, 1, "BVA", 466);
        /*
		setTimeout(() => { 
		
			console.log("Adding 1 more!"); 
			managerTrade(-1, "BNBBTC", 0.0025674, 1, "BVA", 466);
		
		}, 3000);
		
		
		setTimeout(() => { 
		
			console.log("Adding 1 more!"); 
			managerTrade(1, "XRPBTC", 0.00001076, 0.6, "BVA", 466);
		
		}, 3000);
		setTimeout(() => { 
		
			console.log("Adding 1 more!"); 
			managerTrade(1, "XTZBTC", 0.0000717, 0.6, "BVA", 466);
		
		}, 6000);
		*/
        /*
		setTimeout(() => { 
		
			console.log("Adding 1 more!"); 
			managerTrade(1, "ALGOBTC", 0.0000251, 0.6, "BVA", 466);
		
		}, 30000);
		setTimeout(() => { 
		
			console.log("Adding 1 more!"); 
			managerTrade(1, "WAVESBTC", 0.0002127, 0.6, "BVA", 466);
		
		}, 60000);
		
		setTimeout(() => { 
		
			console.log("Selling 1!"); 
			managerTrade(-1, "WAVESBTC", 0.0002127, 0.6, "BVA", 466);
		
		}, 100000);
		*/
    }

    test_trades = false
}

//}

run()
