import harbor.ReplayFormat;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

public class ReplayFormatCheck{
    public static void main(String[] args) throws Exception{
        Path file=Path.of(args[1]);
        if(args[0].equals("segments")){
            for(Path segment:ReplayFormat.segments(file))System.out.println("\""+segment.getFileName()+"\"");
            return;
        }
        if(args[0].equals("write")){
            int count=Integer.parseInt(args[2]);
            boolean close=!args[3].equals("open");
            Random random=new Random(7);
            var writer=new ReplayFormat.Writer(file,"{\"format\":\"mindustry-replay/1\",\"segment\":0}");
            for(int i=0;i<count;i++){
                byte kind=i%25==0?ReplayFormat.KEYFRAME:i%40==1?ReplayFormat.MARK:ReplayFormat.PACKET;
                byte[] data=new byte[i%97==0?200_000:random.nextInt(900)];
                random.nextBytes(data);
                long t=1_000_000L*i;
                byte id=(byte)(kind==ReplayFormat.PACKET?random.nextInt(256):0);
                writer.write(ReplayFormat.encode(kind,t,id,data));
                System.out.println(line(kind,t,id,data));
                if(i%10==9)writer.flush();
            }
            if(close)writer.close();
            else writer.flush();
            return;
        }
        try(var reader=new ReplayFormat.Reader(file)){
            System.out.println("{\"header\":"+reader.header+"}");
            for(ReplayFormat.Record r;(r=reader.next())!=null;)System.out.println(line(r.kind(),r.t(),r.packetId(),r.data()));
            System.out.println("{\"cut_short\":"+(reader.cutShort==null?"null":"true")+"}");
        }
    }

    static String line(byte kind,long t,byte id,byte[] data) throws Exception{
        return "{\"kind\":"+kind+",\"t\":"+t+",\"id\":"+(id&0xff)+",\"bytes\":"+data.length+",\"sha256\":\""+HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data))+"\"}";
    }
}
