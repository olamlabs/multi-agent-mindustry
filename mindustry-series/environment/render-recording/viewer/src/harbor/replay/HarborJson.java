package harbor.replay;

import java.util.*;

final class HarborJson{
    private HarborJson(){}

    static String object(Object... pairs){
        LinkedHashMap<String,Object> map=new LinkedHashMap<>();
        for(int i=0;i<pairs.length;i+=2)map.put((String)pairs[i],pairs[i+1]);
        return value(map);
    }

    static String value(Object v){
        if(v==null)return "null";
        if(v instanceof Number n)return Double.isFinite(n.doubleValue())?n.toString():"null";
        if(v instanceof Boolean)return v.toString();
        if(v instanceof Map<?,?> m){
            StringJoiner out=new StringJoiner(",","{","}");
            for(var e:m.entrySet())out.add(value(e.getKey().toString())+":"+value(e.getValue()));
            return out.toString();
        }
        if(v instanceof Iterable<?> list){
            StringJoiner out=new StringJoiner(",","[","]");
            for(Object x:list)out.add(value(x));
            return out.toString();
        }
        StringBuilder b=new StringBuilder("\"");
        for(char c:v.toString().toCharArray()){
            switch(c){
                case '"'->b.append("\\\"");
                case '\\'->b.append("\\\\");
                case '\n'->b.append("\\n");
                case '\r'->b.append("\\r");
                case '\t'->b.append("\\t");
                default->{
                    if(c<32)b.append(String.format("\\u%04x",(int)c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }
}
