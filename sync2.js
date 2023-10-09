const WebSocket = require('ws');
const {Serialize} = require('enf-eosjs');
require('dotenv').config();

const endpoint = process.env.SHIP_WS_DEST;


class SYNC {
    constructor() {
        this.abi = null;
        this.types = null;
        this.blocksQueue = [];
        this.inProcessBlocks = false;
        this.currentArgs = null;
        this.connectionRetries = 0;
        this.maxConnectionRetries = 100;
    }

    start() {

        console.log(`Websocket connecting to ${endpoint}`);
        this.ws = new WebSocket(endpoint, {perMessageDeflate: false});
        this.ws.on('message', data => {
            //if abi is not set, it means we are receiving an abi
            if (!this.abi) {
                this.rawabi = data;
                this.abi = JSON.parse(data);
                this.types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), this.abi);
                //request ship status
                return this.send(['get_status_request_v0', {}]);
            }
            //Receiving blocks
            const [type, response] = this.deserialize('result', data);

            // console.log("response = " + JSON.stringify(response));
            this[type](response);
        });
        this.ws.on('close', code => {
            console.error(`Websocket disconnected from ${process.env.SHIP_WS} with code ${code}`);
            this.abi = null;
            this.types = null;
            this.blocksQueue = [];
            this.inProcessBlocks = false;
            if (code !== 1000) this.reconnect();
        });
        this.ws.on('error', (e) => {
            console.error(`Websocket error`, e)
        });
    }

    disconnect() {
        console.log(`Closing connection`);
        this.ws.close();
    }

    reconnect() {
        if (this.connectionRetries > this.maxConnectionRetries) return console.error(`Exceeded max reconnection attempts of ${this.maxConnectionRetries}`);
        const timeout = Math.pow(2, this.connectionRetries / 5) * 1000;
        console.log(`Retrying with delay of ${timeout / 1000}s`);
        setTimeout(() => {
            this.start(process.env.SHIP_WS);
        }, timeout);
        this.connectionRetries++;
    }

    serialize(type, value) {
        const buffer = new Serialize.SerialBuffer({textEncoder: new TextEncoder, textDecoder: new TextDecoder});
        Serialize.getType(this.types, type).serialize(buffer, value);
        return buffer.asUint8Array();
    }

    deserialize(type, array) {
        const buffer = new Serialize.SerialBuffer({textEncoder: new TextEncoder, textDecoder: new TextDecoder, array});
        return Serialize.getType(this.types, type).deserialize(buffer, new Serialize.SerializerState({bytesAsUint8Array: true}));
    }

    send(request) {
        this.ws.send(this.serialize('request', request));
    }

    requestBlocks(requestArgs) {
        if (!this.currentArgs) this.currentArgs = {
            start_block_num: 100,
            end_block_num: 0xffffffff,
            max_messages_in_flight: 50,
            have_positions: [],
            irreversible_only: true,
            fetch_block: true,
            fetch_traces: true,
            fetch_deltas: false,
            ...requestArgs
        };
        this.send(['get_blocks_request_v0', this.currentArgs]);
    }

    async get_status_result_v0(response) {
        const start_block_num =1660000;

        this.requestBlocks({start_block_num, irreversible_only: false})
    }

    // ws send get_blocks_request_v0 type会返回get_blocks_result_v0 并自动调用
    get_blocks_result_v0(response) {
        this.blocksQueue.push(response);
        this.processBlocks();
    }

    async processBlocks() {
        if (this.inProcessBlocks) return;
        this.inProcessBlocks = true;
        while (this.blocksQueue.length) {
            let response = this.blocksQueue.shift();
            if (response.this_block) {
                let block_num = response.this_block.block_num;
                this.currentArgs.start_block_num = block_num ; // replay 25 seconds
            }
            this.send(['get_blocks_ack_request_v0', {num_messages: 1}]);
            await this.receivedBlock(response);
        }
        this.inProcessBlocks = false;
    }


    async receivedBlock(response) {
        if (!response.this_block) return;

        let traces = [];
        if (response.traces) {
            traces = this.deserialize("transaction_trace[]", response.traces);
        }
        const block = this.deserialize("signed_block", response.block);
        let transactions = [];

        let header = {...block};
        delete header.transactions;
        delete header.block_extensions;
        delete header.producer_signature;

        for (var txRaw of traces) {
            let tx = txRaw[1];
            let action_traces = [];
            for (var t of tx.action_traces) {
                let trace = t[1];
                trace.receipt = trace.receipt[1];
                action_traces.push(trace);
            }
            tx.action_traces = action_traces;
            transactions.push(tx)
        }

        const result = {
            id: response.this_block.block_id,
            block_num: response.this_block.block_num,
            header,
            producer_signature: block.producer_signature,
            transactions,
        }

        let block_num = response.this_block.block_num;


        console.log("块:" + block_num + ",交易数 :" + (transactions.length - 1))

        // }
        this.current_block = block_num;

        if (!(block_num % 1000)) {
            const progress = (100 * ((this.current_block) / response.head.block_num)).toFixed(2)
            console.log(`SHIP: ${progress}% (${this.current_block}/${response.head.block_num})`);
        }

        if (this.current_block === this.end_block - 1) {
            console.log(`SHIP done streaming`)
            this.disconnect()
        }

    }
}


(async () => {
    const sync = new SYNC();
    sync.start();
})()