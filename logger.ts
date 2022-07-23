import { bufferToHex } from "ethereumjs-util";
import { DetailedTxStatus, TxStatus, txStatuses, verbose } from "./api";
import {db} from './storage/sqliteStorage';
import { getReasonEnumCode, getTransactionObj } from "./utils";

const EventEmitter = require('events');
const config = require('./config');

type ApiPerfLogData = {
    [key: string]: {
        count: number
        tMin: number
        tMax: number
        tTotal: number
        tAvg?: number
    }
}

type ApiPerfLogTicket = {
    [key: string]: {
        api_name: string
        start_timer: number
    }
}

export const mutedEvents: any = {
    on: () => {
        console.log("=> Logging is disabled")
    },
    emit: () => {}
}

export let apiPerfLogData: ApiPerfLogData = {}
export let apiPerfLogTicket: ApiPerfLogTicket = {}
export const logEventEmitter =  new EventEmitter() 

export function apiPefLogger(){
    console.log(`=> API PERF RESULTS`)
    for ( const [key, value] of Object.entries(apiPerfLogData)){
        const api = key
        const {  tMin, tMax, tTotal,  count } = value


        console.log(
            `Api: ${api},
            Count: ${count},
            Min: ${tMin.toFixed(3)} ms, 
            Max: ${tMax.toFixed(3)} ms,
            Total: ${tTotal.toFixed(3)} ms,
            Avg: ${(tTotal/count).toFixed(3)} ms,
            Request per second: ${(count/process.uptime()).toFixed(3)} req/s`
        )
    }
    // clean up every set Interval
    console.log(apiPerfLogTicket)
    apiPerfLogTicket = {}
}

export function setupLogEvents () {
    if(config.statLog){
        logEventEmitter.on('fn_start', (ticket: string, api_name: string, start_timer: number) => {

          apiPerfLogTicket[ticket] = {
            api_name: api_name,
            start_timer: start_timer
          }
        })

        logEventEmitter.on('fn_end', (ticket: string, end_timer: number) => {

          if (!apiPerfLogTicket.hasOwnProperty(ticket)) return

          const {api_name, start_timer} = apiPerfLogTicket[ticket]
          // tfinal is the time it took to complete an api
          const tfinal = end_timer - start_timer;
          if (apiPerfLogData.hasOwnProperty(api_name)) {

            apiPerfLogData[api_name].count += 1
            apiPerfLogData[api_name].tTotal += tfinal

            const tMin = apiPerfLogData[api_name].tMin
            const tMax = apiPerfLogData[api_name].tMax

            apiPerfLogData[api_name].tMin = (tfinal < tMin) ? tfinal : tMin
            apiPerfLogData[api_name].tMax = (tfinal > tMax) ? tfinal : tMax

          }
          if (!apiPerfLogData.hasOwnProperty(api_name)) {
            apiPerfLogData[api_name] = {
              count: 1,
              tMin: tfinal,
              tMax: tfinal,
              tTotal: tfinal,
            }
          }
          delete apiPerfLogTicket[ticket]
        })
    }

    if(config.recordTxStatus){
        logEventEmitter.on('tx_insert_db', async(_txs: TxStatus[]) => {
            const txs = _txs as any[];
            const detailedList: DetailedTxStatus[] = [];

            for await (const txStatus of txs){
              // console.log(txStatus)

              if(!txStatus.raw) continue

              try{
                let type = 'other'
                const tx = await getTransactionObj({raw: txStatus.raw})

                delete txStatus.raw


                if((tx.to === undefined) && tx.data){
                   type = "contract deployment"
                }
                else if(tx.value && (tx.data.length === 0)){
                   type = "coin transfer"
                }
                else{
                   type = "contract call"
                }

                txStatus.accepted = getReasonEnumCode(txStatus.reason);

                detailedList.push( {
                  ...txStatus,
                  type: type,
                  to: bufferToHex(tx.to),
                  from: bufferToHex(tx.getSenderAddress())
                })
              }catch(e){
                continue
              }
            }
            txStatusSaver(detailedList);
        })
    }
}

// this function save recorded transaction to sqlite with its tx type 
export async function txStatusSaver(_txs: DetailedTxStatus[]) {
    const txs = _txs;

    // construct string to be a valid sql string, NOTE> insert value needs to be in order
    const prepareSQL = ({txHash, injected, accepted, reason, type, to, from, ip}: DetailedTxStatus) => {
        return `INSERT INTO transactions` +
                ` VALUES ('${txHash}', '${type}', '${to}', '${from}', '${injected}', '${accepted}', '${reason}', '${ip}')`
    }
    
    for await(const tx of txs) {
        try{
            await db.exec(prepareSQL(tx))
        }catch(e){
            continue
        }
    }
}
