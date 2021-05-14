// read .env file into proces.env
require("dotenv").config()

const envalid = require("envalid")
var pjson = require("../package.json")

module.exports = envalid.cleanEnv(process.env, {
    BACKTEST_TEST_PAIR: envalid.str({ default: "BTCUSDT" }),
    BALANCE_LONG: envalid.num({ default: 0.0002 }),
    BALANCE_SPOT: envalid.num({ default: 0.0005 }),
    BALANCE_SHORT: envalid.num({ default: 0.0002 }),
    BINANCE_API_KEY: envalid.str(),
    BINANCE_SECRET_KEY: envalid.str(),
    BVA_API_KEY: envalid.str(),
    CONNECT_SERVER_TO_BVA: envalid.bool({ default: true }),
    DATABASE_CONNECT_VIA_SSL: envalid.bool({ default: false }),
    DATABASE_INSERT_PAIR_HISTORY: envalid.bool({ default: true }),
    DATABASE_URL: envalid.str({
        default:
            "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    }),
    GMAIL_ADDRESS: envalid.str({ default: "" }),
    GMAIL_APP_PASSWORD: envalid.str({ default: "" }),
    HOST: envalid.str({ default: "localhost" }),
    MONGO_URI: envalid.str({ default: "" }),
    MONGO_INITDB_ROOT_USERNAME: envalid.str(),
    MONGO_INITDB_ROOT_PASSWORD: envalid.str(),
    SERVER_PORT: envalid.port({
        default: 4000,
        desc: "The port to start the server on",
    }),
    SLACK_WEBHOOK_URL: envalid.str({ default: ""}),
    STRATEGY_TIMEFRAME: envalid.str({ default: "15m" }),
    TELEGRAM_API_KEY: envalid.str({ default: "" }),
    TELEGRAM_RECEIVER_ID: envalid.str({ default: "" }),
    TRADE_SHORT_ENABLED: envalid.bool({ default: true }),
    TRADER_PORT: envalid.port({
        default: 8003,
        desc: "The port to trader webserver runs",
    }),
    USE_GMAIL: envalid.bool({ default: false }),
    USE_TELEGRAM: envalid.bool({ default: false }),
    VERSION: envalid.str({ default: pjson.version }),
})
