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
import idl from '../../target/idl/solana_chunk_uploader.json';
import './App.css';

const PROGRAM_ID = new PublicKey(idl.address);
const CHUNK_SIZE = 800; // 800 Bytes (well within the raw 1232 MTU limit)

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function App() {
  const [status, setStatus] = useState('Idle');
  const [fileIdToDownload, setFileIdToDownload] = useState('');
  
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<{name: string, size: number, id: string} | null>(null);
  const [downloadedFile, setDownloadedFile] = useState<{name: string, size: number, url: string} | null>(null);
  
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
      setUploadedFile(null);
      await setupWallet();
      setStatus(`Uploading ${file.name}...`);
      const provider = getProvider();
      const program = new Program(idl as Idl, provider);
      
      const fileId = Math.random().toString(36).substring(2, 10);
      const buffer = new Uint8Array(await file.arrayBuffer());

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
        
        const discriminator = Buffer.from([130, 219, 165, 153, 119, 149, 252, 162]);
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
        
        const rawTx = transaction.serialize();
        const base64Tx = Buffer.from(rawTx).toString('base64');
        const signature = await connection.sendEncodedTransaction(base64Tx, { skipPreflight: true, maxRetries: 3 });
        
        await connection.confirmTransaction(signature, 'confirmed');
        const sigBytes = Array.from(bs58.decode(signature));
        signatures.push(sigBytes);
      }
      
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

      setStatus(`Upload complete!`);
      setUploadedFile({
        name: file.name,
        size: file.size,
        id: fileId
      });
    } catch (e: any) {
      console.error(e);
      setStatus(`Upload error: ${e.message}`);
    }
  };

  const downloadFile = async (id: string) => {
    if (!id) return;
    try {
      setDownloadedFile(null);
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
        
        let tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) {
          for (let retries = 0; retries < 15; retries++) {
            await new Promise((r) => setTimeout(r, 2000)); // wait up to 30 seconds
            tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx) break;
          }
        }
        if (!tx) throw new Error(`Transaction ${signature} not found after retries`);
        
        const message = tx.transaction.message;
        let instructions: any[] = [];
        if ('compiledInstructions' in message) {
            instructions = message.compiledInstructions;
        } else {
            instructions = (message as any).instructions;
        }
        
        const ixData = Buffer.from(instructions[0].data);
        const chunk = ixData.slice(12);
        chunks.push(chunk);
      }
      
      const blob = new Blob(chunks as any, { type: manifest.mimeType });
      const url = URL.createObjectURL(blob);
      setDownloadedFile({
        name: manifest.filename,
        size: blob.size,
        url
      });
      setStatus(`Download ready`);
      
    } catch (e: any) {
      console.error(e);
      setStatus(`Download error: ${e.message}`);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      uploadFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="container">
      <h1>Solana File Storage</h1>
      
      <div className="section">
        <h3 className="section-title">Upload File</h3>
        <label 
          className={`dropzone ${isDragging ? 'active' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <input 
            type="file" 
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files[0]) {
                uploadFile(e.target.files[0]);
              }
            }} 
          />
          <div className="dropzone-text">
            <strong>Click to select</strong> or drag and drop a file here
          </div>
        </label>
        
        {uploadedFile && (
          <div className="file-info success">
            <div style={{ marginBottom: '4px' }}>🎉 Uploaded <strong>{uploadedFile.name}</strong> ({formatBytes(uploadedFile.size)})</div>
            <div>
              File ID: <code className="code-id">{uploadedFile.id}</code>
            </div>
          </div>
        )}
      </div>
      
      <div className="section">
        <h3 className="section-title">Download File</h3>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input 
            className="input"
            type="text" 
            placeholder="Enter File ID" 
            value={fileIdToDownload} 
            onChange={(e) => setFileIdToDownload(e.target.value)} 
          />
          <button className="button" onClick={() => downloadFile(fileIdToDownload)}>
            Fetch File
          </button>
        </div>
        
        {downloadedFile && (
          <div className="file-info success download-ready">
            <div>
              Ready: <strong>{downloadedFile.name}</strong> ({formatBytes(downloadedFile.size)})
            </div>
            <a className="button button-outline" href={downloadedFile.url} download={downloadedFile.name}>
              Download
            </a>
          </div>
        )}
      </div>
      
      <div className="status-bar">
        <span className="status-label">Status:</span> {status}
      </div>
    </div>
  );
}

export default App;
