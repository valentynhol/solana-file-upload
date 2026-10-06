import { useState, useRef } from 'react';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as solanaWeb3 from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import idl from '../../target/idl/solana_chunk_uploader.json';

const PROGRAM_ID = new PublicKey(idl.address);


const CHUNK_SIZE = 800; // 800 Bytes (well within the raw 1232 MTU limit)

function App() {
  const [status, setStatus] = useState('');
  const [fileIdToDownload, setFileIdToDownload] = useState('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  
  // Create a throwaway wallet for testing
  const walletRef = useRef(Keypair.generate());
  const wallet = walletRef.current;
  
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  
  const setupWallet = async () => {
    setStatus('Requesting airdrop...');
    const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    setStatus('Airdrop complete.');
  };

  const getProvider = () => {
    return new AnchorProvider(
      connection,
      {
        publicKey: wallet.publicKey,
        signTransaction: async (tx: any) => {
          if ('version' in tx) {
            tx.sign([wallet]);
          } else {
            tx.sign(wallet);
          }
          return tx;
        },
        signAllTransactions: async (txs: any[]) => {
          txs.forEach((tx) => {
            if ('version' in tx) {
              tx.sign([wallet]);
            } else {
              tx.sign(wallet);
            }
          });
          return txs;
        },
      },
      { preflightCommitment: 'confirmed' }
    );
  };

  const uploadFile = async (file: File) => {
    try {
      await setupWallet();
      setStatus(`Uploading ${file.name}...`);
      const provider = getProvider();
      const program = new Program(idl as Idl, provider);
      
      const fileId = Math.random().toString(36).substring(2, 10);
      const buffer = new Uint8Array(await file.arrayBuffer());
      
      // Compute manifestPda if needed or remove completely. Since we don't use it, we can just omit it here.
      // const [manifestPda] = PublicKey.findProgramAddressSync(...);

      setStatus('Initializing file manifest...');
      await program.methods
        .initializeFile(fileId, file.name, file.type)
        .accounts({
          user: wallet.publicKey,
        })
        .rpc();

      const numChunks = Math.ceil(buffer.length / CHUNK_SIZE);
      const signatures: number[][] = [];
      
      for (let i = 0; i < numChunks; i++) {
        setStatus(`Uploading chunk ${i + 1}/${numChunks}...`);
        const chunkBytes = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        
        // Construct the instruction to upload chunk manually to avoid Anchor's serialization stack limit
        // The discriminator for `upload_chunk` is: [130, 219, 165, 153, 119, 149, 252, 162]
        const discriminator = Buffer.from([130, 219, 165, 153, 119, 149, 252, 162]);
        // The parameter is a Vec<u8> which expects a 4-byte length prefix (u32 little endian) followed by the bytes.
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(chunkBytes.length, 0);
        const ixData = Buffer.concat([discriminator, lenBuf, Buffer.from(chunkBytes)]);
        
        const ix = new solanaWeb3.TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [],
          data: ixData
        });
          
        const { blockhash } = await connection.getLatestBlockhash();
        
        const messageV0 = new solanaWeb3.TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: blockhash,
          instructions: [ix],
        }).compileToV0Message();

        const transaction = new solanaWeb3.VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        
        // Ensure encoded in Base64 explicitly
        const rawTx = transaction.serialize();
        const base64Tx = Buffer.from(rawTx).toString('base64');
        const signature = await connection.sendEncodedTransaction(base64Tx, { skipPreflight: true, maxRetries: 3 });
        
        await connection.confirmTransaction(signature, 'confirmed');
        const sigBytes = Array.from(bs58.decode(signature));
        signatures.push(sigBytes);
      }
      
      // Append signatures in batches
      const BATCH_SIZE = 10;
      for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
        setStatus(`Appending signatures batch ${i / BATCH_SIZE + 1}...`);
        const batch = signatures.slice(i, i + BATCH_SIZE);
        await program.methods
          .appendChunkSignatures(fileId, batch)
          .accounts({
            user: wallet.publicKey,
          })
          .rpc();
      }

      setStatus(`Upload complete! File ID: ${fileId}`);
    } catch (e: any) {
      console.error(e);
      setStatus(`Upload error: ${e.message}`);
    }
  };

  const downloadFile = async (id: string) => {
    try {
      setStatus(`Fetching manifest for ${id}...`);
      const provider = getProvider();
      const program = new Program(idl as Idl, provider);
      
      const [manifestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('manifest'), Buffer.from(id)],
        PROGRAM_ID
      );
      
      const manifest: any = await (program as any).account.fileManifest.fetch(manifestPda);
      const chunkSignatures = manifest.chunkSignatures as number[][];
      
      const chunks: Uint8Array[] = [];
      
      for (let i = 0; i < chunkSignatures.length; i++) {
        setStatus(`Fetching chunk ${i + 1}/${chunkSignatures.length}...`);
        const sigBytes = chunkSignatures[i];
        const signature = bs58.encode(Uint8Array.from(sigBytes));
        
        // Fetch transaction with maxSupportedTransactionVersion: 1
        const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 });
        if (!tx) {
          throw new Error(`Transaction ${signature} not found`);
        }
        
        // Extract the chunk bytes
        // The message could be v0 or legacy. We'll handle both.
        const message = tx.transaction.message;
        
        let instructions: any[] = [];
        if ('compiledInstructions' in message) {
            // Versioned transaction (v0)
            instructions = message.compiledInstructions;
        } else {
            // Legacy transaction
            instructions = (message as any).instructions;
        }
        
        // Assuming the upload_chunk is the first and only instruction
        // The data is: 8-byte discriminator + 4-byte length prefix + chunk bytes
        const ixData = Buffer.from(instructions[0].data);
        const chunk = ixData.slice(12);
        chunks.push(chunk);
      }
      
      const blob = new Blob(chunks as any, { type: manifest.mimeType });
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setStatus(`Download ready: ${manifest.filename}`);
      
    } catch (e: any) {
      console.error(e);
      setStatus(`Download error: ${e.message}`);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>Solana L1 File Uploader</h1>
      
      <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc' }}>
        <h3>Upload File</h3>
        <input 
          type="file" 
          onChange={(e) => {
            if (e.target.files && e.target.files[0]) {
              uploadFile(e.target.files[0]);
            }
          }} 
        />
      </div>
      
      <div style={{ marginBottom: '20px', padding: '10px', border: '1px solid #ccc' }}>
        <h3>Download File</h3>
        <input 
          type="text" 
          placeholder="File ID" 
          value={fileIdToDownload} 
          onChange={(e) => setFileIdToDownload(e.target.value)} 
        />
        <button onClick={() => downloadFile(fileIdToDownload)}>Fetch File</button>
        {downloadUrl && (
          <div style={{ marginTop: '10px' }}>
            <a href={downloadUrl} download>Download File</a>
          </div>
        )}
      </div>
      
      <div style={{ padding: '10px', backgroundColor: '#f0f0f0' }}>
        <strong>Status:</strong> {status}
      </div>
    </div>
  );
}

export default App;
