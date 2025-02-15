/*
   * Base Simpel
   * Created By Dii Coders
*/

const {
  makeWASocket,
  jidDecode,
  proto,
  getContentType,
  makeInMemoryStore,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const readline = require("readline");
const pkg = require("./package.json");
const config = require("./settings.js");
const question = (text) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  
  return new Promise((resolve) => {
    rl.question(text, resolve)
  })
}

const store = makeInMemoryStore({
  logger: pino().child({ level: "fatal" })
})

async function startBase() {
  const {
    state,
    saveCreds
  } = await useMultiFileAuthState("session")
  
  const client = makeWASocket({
    printQRInTerminal: false,
    browser: ["Windows", "Edge", ""],
    logger: pino({ level: "fatal" }),
    auth: state
  })
  
  if(!client.authState.creds.registered) {
    console.log("Mohon Masukan Nomor Telpon. ex 62xxxx")
    const phoneNumber = await question("PHONE: ")
    const code = await client.requestPairingCode(phoneNumber)
    console.log(`PAIRING CODE: ${code}`)
  }
  
  client.ev.on("creds.update", saveCreds)
  store.bind(client.ev)
  client.public = true
  
  client.ev.on("connection.update", ({ connection }) => {
    if(connection === "open") console.log("terhubung");
    if(connection === "close") startBase();
  });
  global.pg = new (await require(process.cwd() + "/lib/plugins"))(
    process.cwd() + "/system/plugins",
  );
  await pg.watch();

  
  client.ev.on('messages.upsert', async chatUpdate => {
    try {
        let msg = chatUpdate.messages[0];
        if (!msg.message) return;
        msg.message = (Object.keys(msg.message)[0] === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        if (msg.key && msg.key.remoteJid === 'status@broadcast') return;
        if (!client.public && !msg.key.fromMe && chatUpdate.type === 'notify') return;
        if (msg.key.id.startsWith('BAE5') && msg.key.id.length === 16) return;
        
        let m = smsg(client, msg, store);
        require("./messages.js")(client, m, chatUpdate, store);
    } catch (err) {
        console.log(err);
    }
  })
  
  client.decodeJid = (jid) => {
    if (!jid) return jid
    if (/:\d+@/gi.test(jid)) {
      let decode = jidDecode(jid) || {}
      return decode.user && decode.server && decode.user + '@' + decode.server || jid
    } else return jid
  }
  
  client.sendText = (jid, text, quoted = '', options) => client.sendMessage(jid, { text: text, ...options }, { quoted })
}

startBase()

function smsg(client, m, store) {
    if (!m) return m;
    let M = proto.WebMessageInfo;
    if (m.key) {
        m.id = m.key.id;
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16;
        m.chat = m.key.remoteJid;
        m.fromMe = m.key.fromMe;
        m.isGroup = m.chat.endsWith('@g.us');
        m.sender = client.decodeJid(m.fromMe && client.user.id || m.participant || m.key.participant || m.chat || '');
        if (m.isGroup) m.participant = client.decodeJid(m.key.participant) || '';
    }
    if (m.message) {
        m.mtype = getContentType(m.message);
        m.msg = (m.mtype == 'viewOnceMessage' ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)] : m.message[m.mtype]);
        m.body = m.message.conversation || m.msg.caption || m.msg.text || (m.mtype == 'listResponseMessage') && m.msg.singleSelectReply.selectedRowId || (m.mtype == 'buttonsResponseMessage') && m.msg.selectedButtonId || (m.mtype == 'viewOnceMessage') && m.msg.caption || m.text;
        let quoted = m.quoted = m.msg.contextInfo ? m.msg.contextInfo.quotedMessage : null;
        m.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
        if (m.quoted) {
            let type = getContentType(quoted);
            m.quoted = m.quoted[type];
            if (['productMessage'].includes(type)) {
                type = getContentType(m.quoted);
                m.quoted = m.quoted[type];
            }
            if (typeof m.quoted === 'string') m.quoted = {
                text: m.quoted
            };
            m.quoted.mtype = type;
            m.quoted.id = m.msg.contextInfo.stanzaId;
            m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat;
            m.quoted.isBaileys = m.quoted.id ? m.quoted.id.startsWith('BAE5') && m.quoted.id.length === 16 : false;
            m.quoted.sender = client.decodeJid(m.msg.contextInfo.participant);
            m.quoted.fromMe = m.quoted.sender === client.decodeJid(client.user.id);
            m.quoted.text = m.quoted.text || m.quoted.caption || m.quoted.conversation || m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || '';
            m.quoted.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
            m.getQuotedObj = m.getQuotedMessage = async () => {
                if (!m.quoted.id) return false;
                let q = await store.loadMessage(m.chat, m.quoted.id, conn);
                return exports.smsg(client, q, store);
            };
            let vM = m.quoted.fakeObj = M.fromObject({
                key: {
                    remoteJid: m.quoted.chat,
                    fromMe: m.quoted.fromMe,
                    id: m.quoted.id
                },
                message: quoted,
                ...(m.isGroup ? { participant: m.quoted.sender } : {})
            });
            m.quoted.delete = () => client.sendMessage(m.quoted.chat, { delete: vM.key });
            m.quoted.copyNForward = (jid, forceForward = false, options = {}) => client.copyNForward(jid, vM, forceForward, options);
            m.quoted.download = () => client.downloadMediaMessage(m.quoted);
        }
    }
    if (m.msg.url) m.download = () => client.downloadMediaMessage(m.msg);
    m.text = m.msg.text || m.msg.caption || m.message.conversation || m.msg.contentText || m.msg.selectedDisplayText || m.msg.title || '';
    m.reply = (text, chatId = m.chat, options = {}) => Buffer.isBuffer(text) ? client.sendMedia(chatId, text, 'file', '', m, { ...options }) : client.sendText(chatId, text, m, { ...options });
    m.copy = () => exports.smsg(client, M.fromObject(M.toObject(m)));
    m.copyNForward = (jid = m.chat, forceForward = false, options = {}) => client.copyNForward(jid, m, forceForward, options);

    return m;
}
