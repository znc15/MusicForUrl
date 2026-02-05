const CryptoJS = require('crypto-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_KEY_LENGTH = 16;
const RECOMMENDED_KEY_LENGTH = 32;

const KEY_FILE = path.join(__dirname, '..', 'data', '.encryption_key');

let cachedKey = null;

function generateSecureKey() {
  return crypto.randomBytes(32).toString('hex').substring(0, 32);
}

function loadKeyFromFile() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (key && key.length >= MIN_KEY_LENGTH) {
        return key;
      }
    }
  } catch (e) {
  }
  return null;
}

function saveKeyToFile(key) {
  try {
    const dir = path.dirname(KEY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    return true;
  } catch (e) {
    console.warn('警告: 无法保存加密密钥到文件:', e.message);
    return false;
  }
}

function initializeKey() {
  const isProduction = process.env.NODE_ENV === 'production';
  
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey.length >= MIN_KEY_LENGTH) {
    if (envKey.length < RECOMMENDED_KEY_LENGTH) {
      console.warn(`提示: ENCRYPTION_KEY 长度为 ${envKey.length}，建议使用 ${RECOMMENDED_KEY_LENGTH} 个字符`);
    }
    return envKey;
  }
  
  if (isProduction) {
    console.error('==================================================');
    console.error('错误: 生产环境必须配置 ENCRYPTION_KEY');
    console.error(`要求: 至少 ${MIN_KEY_LENGTH} 个字符，建议 ${RECOMMENDED_KEY_LENGTH} 个字符`);
    console.error('示例: ENCRYPTION_KEY=your-32-character-secret-key-here');
    console.error('==================================================');
    process.exit(1);
  }
  
  const fileKey = loadKeyFromFile();
  if (fileKey) {
    console.log('已加载持久化的加密密钥');
    return fileKey;
  }
  
  const newKey = generateSecureKey();
  console.log('====================================');
  console.log('已自动生成加密密钥（开发环境）');
  if (saveKeyToFile(newKey)) {
    console.log(`密钥已保存到: ${KEY_FILE}`);
  }
  console.log('生产环境请通过 ENCRYPTION_KEY 环境变量配置');
  console.log('====================================');
  return newKey;
}

cachedKey = initializeKey();

function getKey() {
  return cachedKey;
}

function encrypt(text) {
  if (!text) return '';
  return CryptoJS.AES.encrypt(text, getKey()).toString();
}

function decrypt(ciphertext) {
  if (!ciphertext) return '';
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, getKey());
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    console.error('解密失败:', e);
    return '';
  }
}

function generateToken() {
  const { v4: uuidv4 } = require('uuid');
  return uuidv4().replace(/-/g, '');
}

module.exports = {
  encrypt,
  decrypt,
  generateToken
};
