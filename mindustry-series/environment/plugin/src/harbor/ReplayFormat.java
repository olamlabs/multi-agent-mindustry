package harbor;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

public final class ReplayFormat{
    public static final byte[] MAGIC="MREPLAY1".getBytes(StandardCharsets.US_ASCII);
    public static final byte PACKET=1,KEYFRAME=2,MARK=3;
    public static final String SUFFIX=".mreplay";

    private ReplayFormat(){}

    public record Record(byte kind,long t,byte packetId,byte[] data){}

    public static byte[] encode(byte kind,long t,byte packetId,byte[] data){
        ByteArrayOutputStream bytes=new ByteArrayOutputStream(data.length+18);
        DataOutputStream out=new DataOutputStream(bytes);
        try{
            out.writeByte(kind);
            out.writeLong(t);
            if(kind==PACKET)out.writeByte(packetId);
            out.writeInt(data.length);
            out.write(data);
        }catch(IOException impossible){
            throw new UncheckedIOException(impossible);
        }
        return bytes.toByteArray();
    }

    public static byte kind(byte[] record){
        return record[0];
    }

    public static long time(byte[] record){
        long t=0;
        for(int i=1;i<=8;i++)t=(t<<8)|(record[i]&0xff);
        return t;
    }

    public static String segmentName(int segment){
        return String.format("segment-%03d%s",segment,SUFFIX);
    }

    public static List<Path> segments(Path path) throws IOException{
        if(!Files.isDirectory(path))return List.of(path);
        try(var stream=Files.list(path)){
            return stream.filter(p->p.getFileName().toString().matches("segment-[0-9]+\\.mreplay"))
                .sorted(Comparator.comparing(p->new java.math.BigInteger(p.getFileName().toString().substring(8,p.getFileName().toString().length()-SUFFIX.length())))).toList();
        }
    }

    public static final class Writer implements Closeable{
        private final GZIPOutputStream gzip;

        public Writer(Path path,String header) throws IOException{
            OutputStream file=new BufferedOutputStream(Files.newOutputStream(path,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE),1<<16);
            byte[] json=header.getBytes(StandardCharsets.UTF_8);
            DataOutputStream head=new DataOutputStream(file);
            head.write(MAGIC);
            head.writeInt(json.length);
            head.write(json);
            gzip=new GZIPOutputStream(file,1<<16,true);
        }

        public void write(byte[] record) throws IOException{
            gzip.write(record);
        }

        public void flush() throws IOException{
            gzip.flush();
        }

        @Override
        public void close() throws IOException{
            gzip.close();
        }
    }

    public static final class Reader implements Closeable{
        public final String header;
        private final DataInputStream in;
        public String cutShort;

        public Reader(Path path) throws IOException{
            InputStream raw=new BufferedInputStream(Files.newInputStream(path),1<<16);
            DataInputStream head=new DataInputStream(raw);
            byte[] magic=new byte[MAGIC.length];
            head.readFully(magic);
            if(!Arrays.equals(magic,MAGIC))throw new IOException(path+" is not a replay segment");
            byte[] json=new byte[head.readInt()];
            head.readFully(json);
            header=new String(json,StandardCharsets.UTF_8);
            in=new DataInputStream(new BufferedInputStream(new GZIPInputStream(raw,1<<16),1<<16));
        }

        public Record next() throws IOException{
            int kind;
            try{
                kind=in.read();
            }catch(EOFException|ZipException e){
                cutShort=describe("the segment ends without its gzip trailer",e);
                return null;
            }
            if(kind<0)return null;
            try{
                long t=in.readLong();
                byte id=kind==PACKET?in.readByte():0;
                byte[] data=new byte[in.readInt()];
                in.readFully(data);
                return new Record((byte)kind,t,id,data);
            }catch(EOFException|ZipException e){
                cutShort=describe("the segment ends inside a record",e);
                return null;
            }
        }

        private static String describe(String what,IOException e){
            return e.getMessage()==null?what:what+" ("+e.getMessage()+")";
        }

        @Override
        public void close() throws IOException{
            in.close();
        }
    }
}
